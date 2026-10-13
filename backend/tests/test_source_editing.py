import io
import json
import zipfile

import pytest
from django.db import DatabaseError, IntegrityError, transaction
from django.test import Client, RequestFactory

from specmate.access.models import Membership
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.sources import blobstore, editing, zip_intake
from specmate.sources.api import read_revision
from specmate.sources.models import (
    SourceBlob,
    SourceBundle,
    SourceBundleFile,
    SourceBundleRevision,
    SourceEditSubmission,
)

from .conftest import op
from .test_sources import register, sha

ORIGINAL = {
    "board/main.native": b"(synthetic board v1)\n",
    "board/notes.txt": b"synthetic notes\n",
    "scripts/run.py": b"raise SystemExit('inert synthetic script')\n",
}


def hide_archive_member(users, revision_id):
    """A retained source closure may become inaccessible independently of its owner."""
    user = users["owner"]
    project = op(user, "project.create", {"name": "Private retained source"})["project_id"]
    content = b"synthetic private retained source"
    register(user, project, content)
    SourceBundleFile.objects.create(
        revision_id=revision_id,
        path="private-evidence.txt",
        blob=SourceBlob.objects.get(project_id=project, sha256=sha(content)),
        media_type="text/plain",
        rights="unknown",
    )
    Membership.objects.filter(project_id=project, user=user).delete()


def original(users, project, contents=ORIGINAL, rights="synthetic-original"):
    for data in contents.values():
        register(users["editor"], project, data)
    return op(
        users["editor"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Synthetic native bundle",
            "files": [
                {"path": p, "sha256": sha(d), "media_type": "text/plain", "rights": rights}
                for p, d in contents.items()
            ],
        },
    )


def export(user, revision_id):
    client = Client()
    client.force_login(user)
    return client.get(f"/api/v0/sources/revisions/{revision_id}/handoff")


def unpack(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def repack(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return buffer.getvalue()


def preserve_zip(users, project, data):
    register(users["editor"], project, data)
    return op(
        users["editor"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Edited upload",
            "files": [
                {
                    "path": "edited.zip",
                    "sha256": sha(data),
                    "media_type": "application/zip",
                    "rights": "unknown",
                }
            ],
        },
    )


def edited_zip(users, project, baseline_id, change):
    entries = unpack(export(users["editor"], baseline_id).content)
    change(entries)
    upload = preserve_zip(users, project, repack(entries))
    return {"revision_id": upload["revision_id"], "path": "edited.zip"}


def preview(user, payload):
    return op(user, "source.preview_edit", payload)


def submit(user, payload, review, target="new_derivative", **extra):
    body = {
        **payload,
        "target": target,
        "summary": "Synthetic outside edit",
        "reviewed_sha256": review["review_sha256"],
        **({"name": "Edited synthetic bundle"} if target == "new_derivative" else {}),
        **extra.pop("body", {}),
    }
    return op(user, "source.submit_edit", body, expected_state=review["state"], **extra)


def manifest(revision_id):
    return json.loads(bytes(SourceBundleRevision.objects.get(id=revision_id).manifest))


def test_export_is_deterministic_inert_and_reenterable(users, project):
    source = original(users, project)
    first, second = (
        export(users["viewer"], source["revision_id"]),
        export(users["editor"], source["revision_id"]),
    )
    assert first.status_code == 200 and first["Content-Type"] == "application/zip"
    assert first["X-Content-Type-Options"] == "nosniff"
    assert first.content == second.content
    assert "Synthetic-native-bundle-r1-handoff.zip" in first["Content-Disposition"]
    # The export satisfies the same bounded parser used for re-entry.
    members = zip_intake.inspect_archive(first.content)
    assert sorted(m.path for m in members) == sorted([*ORIGINAL, editing.MARKER])
    entries = unpack(first.content)
    for path, data in ORIGINAL.items():
        assert entries[path] == data
    marker = json.loads(entries[editing.MARKER])
    assert marker["baseline_revision_id"] == source["revision_id"]
    assert marker["manifest_sha256"] == source["manifest_sha256"]
    assert {f["path"]: f["sha256"] for f in marker["files"]} == {
        p: sha(d) for p, d in ORIGINAL.items()
    }
    assert all(f["rights"] == "synthetic-original" for f in marker["files"])
    assert export(users["outsider"], source["revision_id"]).status_code == 404


def test_export_refuses_reserved_marker_path(users, project):
    source = original(users, project, {"sub/specmate-handoff.JSON": b"{}"})
    response = export(users["editor"], source["revision_id"])
    assert response.status_code == 422
    assert "reserved path" in response.json()["error"]["message"]


def test_zip_reentry_reviews_and_creates_separate_derivative(users, project):
    source = original(users, project)

    def change(entries):
        entries["board/main.native"] = b"(synthetic board v2)\n"
        del entries["board/notes.txt"]
        entries["board/added.native"] = b"(synthetic added part)\n"
        entries["__MACOSX/._main.native"] = b"resource fork"

    payload = {
        "baseline_revision_id": source["revision_id"],
        "archive": edited_zip(users, project, source["revision_id"], change),
    }
    first = preview(users["editor"], payload)
    rows = {row["path"]: row for row in first["files"]}
    assert first["marker"] == "matched" and first["root_prefix"] == ""
    assert first["source"]["parser"] == "specmate-classic-zip-v1"
    assert rows["board/main.native"]["change"] == "modified"
    assert rows["board/main.native"]["baseline_sha256"] == sha(ORIGINAL["board/main.native"])
    assert rows["board/main.native"]["rights"] == "synthetic-original"
    assert rows["scripts/run.py"]["change"] == "unchanged"
    assert rows["board/added.native"]["rights_source"] == "missing"
    assert rows["__MACOSX/._main.native"]["suggested_exclusion"] is True
    assert [r["path"] for r in first["removed"]] == ["board/notes.txt"]
    assert first["ready"] is False and first["validation"] == "not_performed"
    assert first["baseline_is_head"] and not first["next_revision_allowed"]
    # Nothing is promoted or recorded by a review.
    assert not SourceBlob.objects.filter(sha256=sha(b"(synthetic board v2)\n")).exists()
    assert SourceBundle.objects.count() == 2
    with pytest.raises(ValidationFailed, match="Declare rights"):
        submit(users["editor"], payload, first)

    payload = {
        **payload,
        "exclude_paths": ["__MACOSX/._main.native"],
        "rights": [{"path": "board/added.native", "rights": "unknown"}],
    }
    reviewed = preview(users["editor"], payload)
    assert reviewed["ready"] and reviewed["review_sha256"] != first["review_sha256"]
    assert reviewed["counts"] == {
        "added": 1,
        "modified": 1,
        "rights_changed": 0,
        "unchanged": 1,
        "removed": 1,
        "excluded": 1,
    }
    result = submit(users["editor"], payload, reviewed, idempotency_key="edit")
    assert result["execution"] == "none" and result["validation"] == "not_performed"
    revision = SourceBundleRevision.objects.select_related("bundle").get(id=result["revision_id"])
    assert revision.bundle.role == "derivative" and revision.number == 1
    assert str(revision.bundle.derived_from_id) == source["revision_id"]
    data = manifest(result["revision_id"])
    assert data["ancestry"] == [source["revision_id"]]
    assert {f["path"]: (f["sha256"], f["rights"]) for f in data["files"]} == {
        "board/main.native": (sha(b"(synthetic board v2)\n"), "synthetic-original"),
        "board/added.native": (sha(b"(synthetic added part)\n"), "unknown"),
        "scripts/run.py": (sha(ORIGINAL["scripts/run.py"]), "synthetic-original"),
    }
    for entry in data["files"]:
        with blobstore.open_blob(entry["sha256"]) as stored:
            assert sha(stored.read()) == entry["sha256"]
    assert manifest(source["revision_id"])["files"] == [
        {
            "path": p,
            "sha256": sha(d),
            "bytes": len(d),
            "media_type": "text/plain",
            "rights": "synthetic-original",
        }
        for p, d in sorted(ORIGINAL.items())
    ]
    request = RequestFactory().get("/")
    request.user = users["viewer"]
    provenance = read_revision(request, result["revision_id"])["edit_submission"]
    assert provenance["baseline_revision_id"] == source["revision_id"]
    assert provenance["source"]["sha256"] == reviewed["source"]["sha256"]
    assert provenance["review_sha256"] == reviewed["review_sha256"]
    assert provenance["target"] == "new_derivative" and provenance["marker"] == "matched"
    # Exact replay, then explicit mismatch.
    assert submit(users["editor"], payload, reviewed, idempotency_key="edit") == result
    assert SourceBundle.objects.count() == 3
    with pytest.raises(IdempotencyMismatch):
        submit(
            users["editor"],
            payload,
            reviewed,
            idempotency_key="edit",
            body={"summary": "different"},
        )


def test_folder_files_strip_marker_root_and_bind_reviewed_rights(users, project):
    source = original(users, project)
    entries = unpack(export(users["editor"], source["revision_id"]).content)
    entries["board/notes.txt"] = b"synthetic notes, edited\n"
    for data in entries.values():
        register(users["editor"], project, data)
    payload = {
        "baseline_revision_id": source["revision_id"],
        "files": [{"path": f"folder/{p}", "sha256": sha(d)} for p, d in entries.items()],
        "rights": [{"path": "scripts/run.py", "rights": "synthetic-relicensed"}],
    }
    reviewed = preview(users["editor"], payload)
    assert reviewed["root_prefix"] == "folder" and reviewed["marker"] == "matched"
    rows = {row["path"]: row for row in reviewed["files"]}
    assert rows["scripts/run.py"]["change"] == "rights_changed"
    assert rows["board/notes.txt"]["change"] == "modified"
    assert editing.MARKER not in rows
    changed = {**payload, "rights": [{"path": "scripts/run.py", "rights": "other"}]}
    with pytest.raises(Conflict, match="review it again"):
        submit(users["editor"], changed, reviewed)
    result = submit(users["editor"], payload, reviewed)
    assert {f["path"] for f in manifest(result["revision_id"])["files"]} == set(ORIGINAL)
    unregistered = {
        **payload,
        "files": [*payload["files"], {"path": "folder/new.txt", "sha256": sha(b"never sent")}],
    }
    with pytest.raises(ValidationFailed, match="not registered"):
        preview(users["editor"], unregistered)


def test_marker_from_other_baseline_and_unchanged_edits_are_explicit(users, project):
    first = original(users, project)
    second = original(users, project, {"other.native": b"(other synthetic)"})
    entries = unpack(export(users["editor"], second["revision_id"]).content)
    upload = preserve_zip(users, project, repack(entries))
    archive = {"revision_id": upload["revision_id"], "path": "edited.zip"}
    with pytest.raises(Conflict, match="different revision") as conflict:
        preview(users["editor"], {"baseline_revision_id": first["revision_id"], "archive": archive})
    assert conflict.value.details == {"exported_from": second["revision_id"]}
    same = preview(
        users["editor"], {"baseline_revision_id": second["revision_id"], "archive": archive}
    )
    assert same["ready"] is False and same["reasons"] == ["No change relative to the baseline."]
    with pytest.raises(ValidationFailed, match="No change"):
        submit(
            users["editor"],
            {"baseline_revision_id": second["revision_id"], "archive": archive},
            same,
        )
    # Removing the marker deliberately is allowed; the baseline is then the selection.
    del entries[editing.MARKER]
    entries["other.native"] = b"(other synthetic, edited)"
    upload = preserve_zip(users, project, repack(entries))
    unmarked = preview(
        users["editor"],
        {
            "baseline_revision_id": first["revision_id"],
            "archive": {"revision_id": upload["revision_id"], "path": "edited.zip"},
            "rights": [{"path": "other.native", "rights": "unknown"}],
        },
    )
    assert unmarked["marker"] == "absent" and unmarked["counts"]["removed"] == 3


def test_stale_baselines_conflict_and_never_merge(users, project):
    source = original(users, project)

    def edit(text):
        return lambda entries: entries.__setitem__("board/main.native", text)

    payload = {
        "baseline_revision_id": source["revision_id"],
        "archive": edited_zip(users, project, source["revision_id"], edit(b"fork base")),
    }
    with pytest.raises(Conflict, match="current head of a derivative"):
        submit(users["editor"], payload, preview(users["editor"], payload), target="next_revision")
    derivative = submit(users["editor"], payload, preview(users["editor"], payload))
    base = derivative["revision_id"]

    alice = {
        "baseline_revision_id": base,
        "archive": edited_zip(users, project, base, edit(b"alice edit")),
    }
    bob = {
        "baseline_revision_id": base,
        "archive": edited_zip(users, project, base, edit(b"bob edit")),
    }
    alice_review, bob_review = preview(users["editor"], alice), preview(users["owner"], bob)
    assert alice_review["next_revision_allowed"] and bob_review["state"] == "bundle-r1"
    next_revision = submit(users["editor"], alice, alice_review, target="next_revision")
    assert next_revision["number"] == 2 and next_revision["state"] == "bundle-r2"
    assert manifest(next_revision["revision_id"])["ancestry"] == [base]

    with pytest.raises(Conflict, match="changed since it was reviewed") as conflict:
        submit(users["owner"], bob, bob_review, target="next_revision")
    assert conflict.value.details["head_revision_id"] == next_revision["revision_id"]
    stale = preview(users["owner"], bob)
    assert not stale["baseline_is_head"] and stale["state"] == "bundle-r2"
    with pytest.raises(Conflict, match="current head of a derivative"):
        submit(users["owner"], bob, stale, target="next_revision")
    with pytest.raises(Conflict, match="changed since"):
        submit(users["owner"], bob, bob_review)
    fork = submit(users["owner"], bob, stale)
    fork_revision = SourceBundleRevision.objects.select_related("bundle").get(
        id=fork["revision_id"]
    )
    assert str(fork_revision.bundle.derived_from_id) == base
    # Both edits survive separately; the earlier ones remain exact.
    contents = {
        r: {f["path"]: f["sha256"] for f in manifest(r)["files"]}["board/main.native"]
        for r in (base, next_revision["revision_id"], fork["revision_id"])
    }
    assert contents == {
        base: sha(b"fork base"),
        next_revision["revision_id"]: sha(b"alice edit"),
        fork["revision_id"]: sha(b"bob edit"),
    }
    assert SourceBundleRevision.objects.get(id=base).bundle.revisions.count() == 2


def test_closure_authorized_before_diagnostics_and_retained_conflicts(users, project):
    source = original(users, project)
    archive = edited_zip(
        users, project, source["revision_id"], lambda e: e.__setitem__("x.native", b"x")
    )
    payload = {
        "baseline_revision_id": source["revision_id"],
        "archive": archive,
        "rights": [{"path": "x.native", "rights": "unknown"}],
    }
    with pytest.raises(PermissionDenied):
        preview(users["viewer"], payload)
    with pytest.raises(NotFound):
        preview(users["outsider"], {**payload, "exclude_paths": ["does-not-exist"]})
    # A foreign archive is hidden before its contents or path diagnostics.
    other = op(users["outsider"], "project.create", {"name": "Foreign"})["project_id"]
    register(users["outsider"], other, b"not a zip")
    foreign = op(
        users["outsider"],
        "source.create_original_bundle",
        {
            "project_id": other,
            "name": "Foreign",
            "files": [
                {"path": "f.zip", "sha256": sha(b"not a zip"), "media_type": "x", "rights": "x"}
            ],
        },
    )
    Membership.objects.create(project_id=other, user=users["editor"], role="viewer")
    with pytest.raises(PermissionDenied):
        preview(
            users["editor"],
            {**payload, "archive": {"revision_id": foreign["revision_id"], "path": "missing"}},
        )
    reviewed = preview(users["editor"], payload)
    result = submit(users["editor"], payload, reviewed, idempotency_key="retained")
    Membership.objects.filter(project_id=project, user=users["editor"]).update(role="viewer")
    for body in ({}, {"summary": "mismatched"}):
        with pytest.raises(PermissionDenied):
            submit(users["editor"], payload, reviewed, idempotency_key="retained", body=body)
    Membership.objects.filter(project_id=project, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        submit(users["editor"], payload, reviewed, idempotency_key="retained")
    request = RequestFactory().get("/")
    request.user = users["viewer"]
    assert read_revision(request, result["revision_id"])["edit_submission"]


def test_persistence_failure_rolls_back_rows(users, project, monkeypatch):
    source = original(users, project)
    payload = {
        "baseline_revision_id": source["revision_id"],
        "archive": edited_zip(
            users, project, source["revision_id"], lambda e: e.__setitem__("y.native", b"y")
        ),
        "rights": [{"path": "y.native", "rights": "unknown"}],
    }
    reviewed = preview(users["editor"], payload)
    before = (SourceBundle.objects.count(), SourceBundleRevision.objects.count())

    def fail(**kwargs):
        raise IntegrityError("synthetic failure")

    monkeypatch.setattr(SourceEditSubmission.objects, "create", fail)
    with pytest.raises(IntegrityError):
        submit(users["editor"], payload, reviewed, idempotency_key="rollback")
    assert (SourceBundle.objects.count(), SourceBundleRevision.objects.count()) == before
    monkeypatch.undo()
    assert submit(users["editor"], payload, reviewed, idempotency_key="rollback")["number"] == 1


def test_database_rejects_inconsistent_or_mutated_provenance(users, project):
    source = original(users, project)
    payload = {
        "baseline_revision_id": source["revision_id"],
        "archive": edited_zip(
            users, project, source["revision_id"], lambda e: e.__setitem__("z.native", b"z")
        ),
        "rights": [{"path": "z.native", "rights": "unknown"}],
    }
    result = submit(users["editor"], payload, preview(users["editor"], payload))
    submission = SourceEditSubmission.objects.get(revision_id=result["revision_id"])
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceEditSubmission.objects.filter(pk=submission.pk).update(summary="rewritten")
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceBundle.objects.filter(id=result["bundle_id"]).update(
            derived_from=None, role="original"
        )
    unrelated = original(users, project, {"u.native": b"u"})
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceEditSubmission.objects.create(
            revision_id=unrelated["revision_id"],
            baseline_id=source["revision_id"],
            marker="absent",
            review_sha256="0" * 64,
            summary="forged",
        )


def test_http_entry_points_use_shared_operations(users, project):
    source = original(users, project)
    entries = unpack(export(users["editor"], source["revision_id"]).content)
    entries["board/main.native"] = b"(http edit)"
    for data in entries.values():
        register(users["editor"], project, data)
    payload = {
        "baseline_revision_id": source["revision_id"],
        "files": [{"path": p, "sha256": sha(d)} for p, d in entries.items()],
    }
    client = Client()
    client.force_login(users["editor"])

    def post(operation, body, **envelope):
        return client.post(
            "/api/v0/operations",
            data=json.dumps(
                {"operation": operation, "request_id": operation, "payload": body, **envelope}
            ),
            content_type="application/json",
        )

    reviewed = post("source.preview_edit", payload)
    assert reviewed.status_code == 200, reviewed.content
    review = reviewed.json()["result"]
    body = {
        **payload,
        "target": "new_derivative",
        "name": "HTTP edit",
        "summary": "HTTP synthetic edit",
        "reviewed_sha256": review["review_sha256"],
    }
    assert post("source.submit_edit", body).status_code == 422
    stale = post("source.submit_edit", body, expected_state="bundle-r9")
    assert stale.status_code == 409 and stale.json()["error"]["details"]["state"] == "bundle-r1"
    created = post("source.submit_edit", body, expected_state=review["state"])
    assert created.status_code == 200, created.content
    assert created.json()["result"]["counts"]["modified"] == 1


@pytest.mark.parametrize("legacy", [False, True])
def test_retained_archive_authority_precedes_replacement_role_diagnostics(users, project, legacy):
    from specmate.operations.models import IdempotencyRecord

    user = users["owner"]
    baseline = original(users, project)
    archive = edited_zip(
        users,
        project,
        baseline["revision_id"],
        lambda entries: entries.__setitem__("board/main.native", b"synthetic edit"),
    )
    payload = {"baseline_revision_id": baseline["revision_id"], "archive": archive}
    reviewed = preview(user, payload)
    submit(user, payload, reviewed, idempotency_key="role-order")
    if legacy:
        IdempotencyRecord.objects.filter(
            actor=user, operation="source.submit_edit", key="role-order"
        ).update(scope="legacy")
    replacement = preserve_zip(users, project, repack({"visible.native": b"visible"}))
    derivative = op(
        user,
        "source.derive_bundle",
        {
            "source_revision_id": replacement["revision_id"],
            "name": "Visible derivative",
        },
    )
    changed = {
        **payload,
        "archive": {"revision_id": derivative["revision_id"], "path": "edited.zip"},
    }
    # Accessible outcomes still use the shared executor's mismatch semantics.
    with pytest.raises(Conflict if legacy else IdempotencyMismatch):
        submit(user, changed, reviewed, idempotency_key="role-order")
    with pytest.raises(ValidationFailed, match="preserved as an original"):
        preview(user, changed)
    with pytest.raises(ValidationFailed, match="preserved as an original"):
        submit(user, changed, reviewed)
    hide_archive_member(users, archive["revision_id"])
    for supplied in (payload, changed):
        with pytest.raises(NotFound):
            submit(user, supplied, reviewed, idempotency_key="role-order")


def test_hidden_newer_head_precedes_preview_and_conflict_metadata(users, project):
    user = users["owner"]
    source = original(users, project)
    derivative = op(
        user,
        "source.derive_bundle",
        {
            "source_revision_id": source["revision_id"],
            "name": "Editable baseline",
        },
    )
    archive = edited_zip(
        users,
        project,
        derivative["revision_id"],
        lambda entries: entries.__setitem__("board/main.native", b"new head edit"),
    )
    next_payload = {"baseline_revision_id": derivative["revision_id"], "archive": archive}
    reviewed = preview(user, next_payload)
    head = submit(user, next_payload, reviewed, target="next_revision")
    register(user, project, b"separate pending edit")
    older = {
        "baseline_revision_id": derivative["revision_id"],
        "files": [
            {"path": "board/main.native", "sha256": sha(b"separate pending edit")},
        ],
    }
    visible = preview(user, older)
    assert visible["head_revision_id"] == head["revision_id"]
    hide_archive_member(users, archive["revision_id"])
    request = RequestFactory().get("/")
    request.user = user
    # The old baseline remains readable. Its inaccessible newer head is a separate closure.
    assert (
        read_revision(request, derivative["revision_id"])["revision_id"]
        == derivative["revision_id"]
    )
    with pytest.raises(NotFound):
        preview(user, older)
    with pytest.raises(NotFound):
        submit(user, older, {**visible, "state": reviewed["state"]})
    with pytest.raises(NotFound):
        submit(user, older, visible, target="next_revision")


@pytest.mark.parametrize("change", ["project", "role", "parent"])
def test_edit_archive_bundle_identity_is_immutable(users, project, change):
    source = original(users, project)
    archive = edited_zip(
        users,
        project,
        source["revision_id"],
        lambda entries: entries.__setitem__("board/main.native", b"reviewed edit"),
    )
    payload = {"baseline_revision_id": source["revision_id"], "archive": archive}
    result = submit(users["owner"], payload, preview(users["owner"], payload))
    archive_revision = SourceBundleRevision.objects.get(id=archive["revision_id"])
    other = op(users["owner"], "project.create", {"name": "Different archive scope"})["project_id"]
    updates = (
        {"project_id": other}
        if change == "project"
        else {
            "role": "derivative",
            "derived_from_id": source["revision_id"],
        }
    )
    if change == "parent":
        # Change both fields to remain a structurally valid bundle; original bundles
        # cannot carry ancestry, so their first parent also changes the role.
        updates["derived_from_id"] = result["revision_id"]
    with (
        pytest.raises(DatabaseError, match="Edit provenance bundle identity"),
        transaction.atomic(),
    ):
        SourceBundle.objects.filter(id=archive_revision.bundle_id).update(**updates)
