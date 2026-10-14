"""Independent permitted-search/preview oracles with registered original source bytes."""

import base64
import binascii
import hashlib
import io
import json
import struct
import zipfile
import zlib
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import WorkspaceMember
from specmate.knowledge.previews import preview_attachment
from specmate.knowledge.search import search_knowledge
from specmate.knowledge.search_contracts import PreviewAttachment, SearchKnowledge
from specmate.operations import NotFound, Unauthenticated, ValidationFailed
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob

from .conftest import member, op, remove_member
from .scope_helpers import workspace_of
from .test_knowledge import attachment_ref, create, part, preserve
from .test_transports import api, post_op


def search(user, text, **extra):
    return op(user, "knowledge.search", {"query": text, **extra})


def attachment(users, project, raw, path="note.txt", media="text/plain"):
    source = preserve(users["owner"], project, "Original attachment", raw, path, media)
    item = create(
        users["owner"],
        project,
        title="Inspection note",
        attachments=[attachment_ref(source, path, "Original evidence")],
    )
    payload = {
        "item_id": item["item_id"],
        "entry_id": item["current"]["entry_id"],
        "bundle_revision_id": source["revision_id"],
        "path": path,
    }
    return item, payload


def png_chunk(kind, body):
    return (
        struct.pack(">I", len(body)) + kind + body + struct.pack(">I", binascii.crc32(kind + body))
    )


def png(width=2, height=1, pixels=b"\x00\xff\x00\x00\x00\xff\x00", extra=b""):
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + extra
        + png_chunk(b"IDAT", zlib.compress(pixels))
        + png_chunk(b"IEND", b"")
    )


def test_text_metadata_history_pagination_and_shared_transports(users, project):
    one = create(
        users["owner"],
        project,
        kind="note",
        title="First calibration",
        body="Independent needle readings.",
    )
    create(
        users["owner"],
        project,
        kind="decision",
        title="Second calibration",
        body="needle rationale",
        decision_status="proposed",
    )
    changed = op(
        users["owner"],
        "knowledge.revise",
        {
            "item_id": one["item_id"],
            "content": {"title": "Updated calibration", "body": "Replacement body"},
        },
        expected_state=one["state"],
    )
    assert search(users["viewer"], "Independent")["results"] == []
    historic = search(users["viewer"], "Independent", include_history=True)["results"][0]
    assert historic["entry_id"] == one["current"]["entry_id"] and historic["current"] is False
    assert historic["matches"] == [{"field": "body", "text": "Independent needle readings."}]
    first = search(users["viewer"], "calibration", limit=1)
    second = search(users["viewer"], "calibration", limit=1, after=first["next_after"])
    assert len(first["results"]) == len(second["results"]) == 1 and second["next_after"] is None
    assert {r["item_id"] for r in first["results"] + second["results"]} >= {one["item_id"]}
    assert all("total" not in page for page in (first, second))
    assert changed["history"][0] == one["current"]
    response = api(users["viewer"]).get(
        "/api/v0/knowledge/search", {"query": "calibration", "limit": 1}
    )
    assert response.json() == first and "no-store" in response["Cache-Control"]
    assert (
        post_op(
            api(users["viewer"]), "knowledge.search", {"query": "calibration", "limit": 1}
        ).json()["result"]
        == first
    )
    assert search(users["outsider"], "calibration")["results"] == []
    with pytest.raises(NotFound):
        search(users["outsider"], "calibration", project_id=project)


def test_membership_loss_never_supplies_snippet_cursor_or_preview(users, project):
    baseline = preserve(
        users["owner"],
        project,
        "Original permitted source",
        b"SECRET NEEDLE\n",
        "note.txt",
        "text/plain",
    )
    derived = op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": baseline["revision_id"], "name": "Exact working source"},
    )
    held = create(
        users["editor"],
        project,
        kind="note",
        title="SECRET NEEDLE",
        attachments=[attachment_ref(derived, "note.txt", "NEEDLE attachment")],
    )
    create(users["editor"], project, kind="note", title="Public needle", body="Visible body")
    before = search(users["viewer"], "needle", limit=1)
    assert before["next_after"] is not None
    payload = {
        "item_id": held["item_id"],
        "entry_id": held["current"]["entry_id"],
        "bundle_revision_id": derived["revision_id"],
        "path": "note.txt",
    }
    prior = op(users["viewer"], "knowledge.preview", payload)
    assert prior["text"] == "SECRET NEEDLE\n"
    # An old attachment stays reachable only for members, even after the entry drops it.
    op(
        users["editor"],
        "knowledge.revise",
        {
            "item_id": held["item_id"],
            "content": {"title": "SECRET NEEDLE current", "body": "Changed without attachment"},
        },
        expected_state=held["state"],
    )
    assert len(search(users["viewer"], "needle", include_history=True)["results"]) == 3
    remove_member(users["viewer"])
    page = search(users["viewer"], "needle", include_history=True, limit=1)
    assert page["results"] == [] and page["next_after"] is None
    assert "SECRET" not in json.dumps(page)
    assert search(users["viewer"], "SECRET", include_history=True)["results"] == []
    with pytest.raises(NotFound):
        search(users["viewer"], "needle", after=held["current"]["entry_id"], include_history=True)
    for data in (payload, {**payload, "path": "wrong.txt"}):
        with pytest.raises(NotFound):
            op(users["viewer"], "knowledge.preview", data)
    member(users["viewer"], "viewer")
    assert op(users["viewer"], "knowledge.preview", payload) == prior
    assert len(search(users["viewer"], "needle", include_history=True)["results"]) == 3


def test_search_filters_by_workspace_and_project_context(users, workspace, project):
    held = create(users["editor"], project, kind="note", title="Held needle", body="x")
    library = op(
        users["editor"],
        "knowledge.create",
        {
            "workspace_id": workspace,
            "kind": "note",
            "content": {"title": "Library needle", "body": "y"},
        },
    )
    both = search(users["viewer"], "needle", workspace_id=workspace)
    assert {r["item_id"] for r in both["results"]} == {held["item_id"], library["item_id"]}
    only = search(users["viewer"], "needle", project_id=project)
    assert [r["item_id"] for r in only["results"]] == [held["item_id"]]
    assert only["results"][0]["project_id"] == project
    assert library["project_id"] is None
    with pytest.raises(NotFound):
        search(users["outsider"], "needle", workspace_id=workspace)
    assert search(users["outsider"], "needle")["results"] == []


def test_membership_loss_hides_the_note_and_its_exact_target_search(users, project):
    _, r1, _ = part(users["owner"], project, "Searchable bracket")
    target = {"kind": "revision", "revision_id": r1["revision_id"]}
    note = create(
        users["owner"],
        project,
        kind="note",
        title="Permitted own title",
        body="Owned knowledge text",
        links=[target],
    )
    before = search(users["viewer"], "Owned", target=target)
    assert (
        api(users["viewer"])
        .get("/api/v0/knowledge/search", {"query": "Owned", "target": json.dumps(target)})
        .json()
        == before
    )
    assert before["results"][0]["links"][0]["target"] == {**target, "feature_id": None}
    assert before["results"][0]["title"] == note["current"]["title"]
    remove_member(users["viewer"])
    assert search(users["viewer"], "Owned")["results"] == []
    with pytest.raises(NotFound):
        search(users["viewer"], "Owned", target=target)
    assert (
        api(users["viewer"])
        .get("/api/v0/knowledge/search", {"query": "Owned", "target": json.dumps(target)})
        .status_code
        == 404
    )
    member(users["viewer"], "viewer")
    assert search(users["viewer"], "Owned", target=target) == before


def test_captured_inactive_actor_and_wrong_item_precede_preview_diagnostics(users, project):
    _, payload = attachment(users, project, b"readable original")
    actor = users["viewer"]
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    for read in (
        lambda: search_knowledge(actor, SearchKnowledge(query="Inspection")),
        lambda: preview_attachment(actor, PreviewAttachment(**payload)),
    ):
        with pytest.raises(Unauthenticated):
            read()
    get_user_model().objects.filter(pk=actor.pk).update(is_active=True)
    assert op(actor, "knowledge.preview", payload)["text"] == "readable original"
    other = create(users["owner"], project, kind="note", body="Not the attachment owner")
    with pytest.raises(NotFound):
        op(actor, "knowledge.preview", {**payload, "item_id": other["item_id"]})


def test_inert_text_independent_hash_rights_and_readonly_preview(users, project, workspace):
    raw = b"<script>window.bad=true</script>\nOriginal UTF-8 text.\n"
    item, payload = attachment(users, project, raw)
    before = SourceBlob.objects.count()
    result = op(users["viewer"], "knowledge.preview", payload)
    assert (
        result["text"] == raw.decode()
        and result["preview_sha256"] == hashlib.sha256(raw).hexdigest()
    )
    assert result["attachment"]["blob_workspace_id"] == workspace
    assert result["attachment"]["rights"] == "synthetic-original"
    assert result["qualification"] == "not_evaluated" and SourceBlob.objects.count() == before
    metadata = search(users["viewer"], "note.txt")["results"][0]
    assert (
        metadata["item_id"] == item["item_id"]
        and metadata["matches"][0]["field"] == "attachment.0.path"
    )
    client = api(users["viewer"])
    response = client.get("/api/v0/knowledge/preview", payload)
    assert response.json() == result and "no-store" in response["Cache-Control"]
    assert post_op(client, "knowledge.preview", payload).json()["result"] == result
    with blobstore.open_blob(result["attachment"]["sha256"]) as stream:
        assert stream.read() == raw


def test_png_normalization_preserves_independent_pixels_and_removes_metadata(users, project):
    raw = png(extra=png_chunk(b"tEXt", b"Comment\x00<script>unsafe text</script>"))
    _, payload = attachment(users, project, raw, "pixels.png", "image/png")
    result = op(users["viewer"], "knowledge.preview", payload)
    normalized = base64.b64decode(result["bytes_base64"])
    assert normalized != raw and b"unsafe" not in normalized and b"tEXt" not in normalized
    assert result["width"] == 2 and result["height"] == 1
    assert hashlib.sha256(normalized).hexdigest() == result["preview_sha256"]
    # Independent fixed chunk offsets: 33-byte signature/header followed by one IDAT.
    size = struct.unpack(">I", normalized[33:37])[0]
    assert normalized[37:41] == b"IDAT"
    assert zlib.decompress(normalized[41 : 41 + size]) == b"\x00\xff\x00\x00\x00\xff\x00"
    assert result["attachment"]["sha256"] == hashlib.sha256(raw).hexdigest()


@pytest.mark.parametrize(
    "raw",
    [
        png() + b"trailer",
        png(width=5000),
        png(pixels=b"x" * 100000),
        png()[:-1] + b"x",
        png(extra=png_chunk(b"acTL", b"animation")),
        png(extra=png_chunk(b"tRNS", struct.pack(">HHH", 255, 0, 0))),
        png(extra=png_chunk(b"texT", b"reserved bit")),
    ],
    ids=["trailing", "dimensions", "inflate", "crc", "animation", "transparency", "reserved-bit"],
)
def test_hostile_or_unsupported_png_is_download_only(users, project, raw):
    _, payload = attachment(users, project, raw, "image.png", "image/png")
    result = op(users["viewer"], "knowledge.preview", payload)
    assert result["kind"] == "download_only" and "bytes_base64" not in result


@pytest.mark.parametrize(
    "path,media,raw",
    [
        ("active.svg", "image/svg+xml", b'<svg onload="alert(1)"/>'),
        ("active.html", "text/html", b"<script>active()</script>"),
        ("script.py", "text/plain", b"print('never execute')"),
        ("manual.pdf", "application/pdf", b"%PDF-1.7"),
        ("big.txt", "text/plain", b"A" * (128 * 1024 + 1)),
    ],
    ids=["svg", "html", "code", "pdf", "large-text"],
)
def test_unsupported_or_large_originals_are_explicit_download_only(
    users, project, path, media, raw
):
    _, payload = attachment(users, project, raw, path, media)
    result = op(users["viewer"], "knowledge.preview", payload)
    assert (
        result["kind"] == "download_only" and "text" not in result and "bytes_base64" not in result
    )


def test_zip_preview_reuses_bounded_parser_and_checks_member_crc(users, project):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("readme.txt", b"Original README")
        archive.writestr("never.py", b"raise RuntimeError('do not run')")
    raw = out.getvalue()
    _, payload = attachment(users, project, raw, "files.zip", "application/zip")
    result = op(users["viewer"], "knowledge.preview", payload)
    assert result["kind"] == "zip"
    assert [(m["path"], m["size"]) for m in result["members"]] == [
        ("readme.txt", 15),
        ("never.py", 32),
    ]
    corrupt = raw.replace(b"Original README", b"Modified README")
    _, bad = attachment(users, project, corrupt, "corrupt.zip", "application/zip")
    assert op(users["viewer"], "knowledge.preview", bad)["kind"] == "download_only"


def test_changed_registered_bytes_never_become_a_preview(users, project):
    raw = b"Original registered text"
    _, payload = attachment(users, project, raw)
    with blobstore.open_blob(hashlib.sha256(raw).hexdigest()) as stream:
        path = stream.name
    # Corrupt only the disposable test artifact, preserving database identity.
    Path(path).chmod(0o600)
    with open(path, "wb") as stream:
        stream.write(b"Corrupted registered text")
    with pytest.raises(ValidationFailed, match="registered integrity"):
        op(users["viewer"], "knowledge.preview", payload)


@pytest.mark.parametrize(
    "paths",
    [["../escape.txt"], [f"member-{n}.txt" for n in range(101)]],
    ids=["traversal", "member-limit"],
)
def test_unsafe_archive_listing_keeps_original_download_only(users, project, paths):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in paths:
            archive.writestr(path, b"original")
    raw = out.getvalue()
    _, payload = attachment(users, project, raw, "unsafe.zip", "application/zip")
    result = op(users["viewer"], "knowledge.preview", payload)
    assert result["kind"] == "download_only" and "members" not in result
    assert result["attachment"]["sha256"] == hashlib.sha256(raw).hexdigest()
    with blobstore.open_blob(result["attachment"]["sha256"]) as stream:
        assert stream.read() == raw


def test_oversize_preview_does_not_claim_unread_integrity(users, project, monkeypatch):
    _, payload = attachment(users, project, b"A" * (2 * 1024 * 1024 + 1))

    def unexpected_read(*args):
        raise AssertionError("Oversize source bytes must not be read for preview")

    monkeypatch.setattr(blobstore, "open_blob", unexpected_read)
    result = op(users["viewer"], "knowledge.preview", payload)
    assert result["kind"] == "download_only"
    assert result["integrity"] == "not_read_for_preview"
    assert result["attachment"]["size"] == 2 * 1024 * 1024 + 1


def committed_revoke(project_id, user):
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections, connections

    def revoke():
        close_old_connections()
        try:
            return WorkspaceMember.objects.filter(
                workspace__projects=project_id, user_id=user.pk
            ).delete()[0]
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(revoke).result(timeout=5) == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "oversized", [False, True], ids=["during-byte-inspection", "oversize-metadata"]
)
def test_preview_rechecks_independently_committed_revocation_before_return(
    users, project, monkeypatch, oversized
):
    from specmate.knowledge import previews

    raw = b"A" * (2 * 1024 * 1024 + 1) if oversized else b"Protected original bytes"
    _, payload = attachment(users, project, raw)
    prior = op(users["viewer"], "knowledge.preview", payload)
    hook = "attachment_result" if oversized else "_inspect"
    original = getattr(previews, hook)

    def revoke_after_read(*args):
        result = original(*args)
        committed_revoke(project, users["viewer"])
        return result

    monkeypatch.setattr(previews, hook, revoke_after_read)
    with pytest.raises(NotFound):
        op(users["viewer"], "knowledge.preview", payload)
    monkeypatch.setattr(previews, hook, original)
    member(users["viewer"], "viewer")
    assert op(users["viewer"], "knowledge.preview", payload) == prior


@pytest.mark.django_db(transaction=True)
def test_search_rechecks_independently_committed_revocation_after_snippet_render(
    users, project, monkeypatch
):
    from specmate.knowledge import search as module

    create(users["owner"], project, kind="note", title="Protected needle", body="Original body")
    prior = search(users["viewer"], "needle")
    original = module.snippet

    def revoke_after_render(*args):
        result = original(*args)
        committed_revoke(project, users["viewer"])
        return result

    monkeypatch.setattr(module, "snippet", revoke_after_render)
    with pytest.raises(NotFound):
        search(users["viewer"], "needle")
    monkeypatch.setattr(module, "snippet", original)
    member(users["viewer"], "viewer")
    assert search(users["viewer"], "needle") == prior


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("exact_target", [False, True], ids=["plain", "exact-target"])
def test_membership_revocation_during_search_fails_closed(
    users, project, monkeypatch, exact_target
):
    from specmate.knowledge import search as module

    _, r1, _ = part(users["owner"], project, "Searchable bracket")
    target = {"kind": "revision", "revision_id": r1["revision_id"]}
    create(
        users["owner"],
        project,
        kind="note",
        title="Owned needle",
        body="Original body",
        links=[target],
    )
    scope = {"target": target} if exact_target else {}
    prior = search(users["viewer"], "needle", **scope)
    original = module.snippet

    def revoke_after_render(*args):
        result = original(*args)
        committed_revoke(project, users["viewer"])
        return result

    monkeypatch.setattr(module, "snippet", revoke_after_render)
    with pytest.raises(NotFound):
        search(users["viewer"], "needle", **scope)
    monkeypatch.setattr(module, "snippet", original)
    member(users["viewer"], "viewer")
    assert search(users["viewer"], "needle", **scope) == prior


@pytest.mark.django_db(transaction=True)
def test_revocation_during_mismatching_blob_read_precedes_integrity_diagnostics(
    users, project, monkeypatch
):
    from contextlib import contextmanager

    _, payload = attachment(users, project, b"Registered original")
    original = blobstore.open_blob
    revoke = True

    @contextmanager
    def mismatching_stream(sha256):
        with original(sha256) as stream:

            class ChangedRead:
                def read(self, size):
                    value = stream.read(size)
                    if revoke:
                        committed_revoke(project, users["viewer"])
                    return value + b"changed"

            yield ChangedRead()

    monkeypatch.setattr(blobstore, "open_blob", mismatching_stream)
    with pytest.raises(NotFound):
        op(users["viewer"], "knowledge.preview", payload)
    member(users["viewer"], "viewer")
    revoke = False
    with pytest.raises(ValidationFailed, match="registered integrity"):
        op(users["viewer"], "knowledge.preview", payload)
    monkeypatch.setattr(blobstore, "open_blob", original)
    assert op(users["viewer"], "knowledge.preview", payload)["text"] == "Registered original"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("stage", ["lookahead", "cursor"])
def test_consumed_pagination_records_reauthorize_after_committed_membership_revocation(
    users, project, monkeypatch, stage
):
    from specmate.knowledge import search as module

    rows = []
    for label in ("first", "second"):
        source = preserve(
            users["owner"],
            project,
            "Original " + label,
            label.encode(),
            "note.txt",
            "text/plain",
        )
        item = create(
            users["owner"],
            project,
            kind="note",
            title="Needle " + label,
            attachments=[attachment_ref(source, "note.txt", "Exact independent source")],
        )
        rows.append((item, project))
    rows.sort(key=lambda row: row[0]["current"]["entry_id"])
    cursor = rows[0][0]["current"]["entry_id"]
    options = {"limit": 1}
    if stage == "cursor":
        options["after"] = cursor
    baseline = search(users["viewer"], "Needle", **options)
    assert baseline["results"][0]["item_id"] == rows[stage == "cursor"][0]["item_id"]
    assert baseline["next_after"] == (cursor if stage == "lookahead" else None)
    # The cursor and lookahead records are positions inside the member's workspace query;
    # only returned records are rendered. Workspace membership covers every record on the
    # page, so a revocation committed while the returned record renders fails the page closed.
    returned_item, _ = rows[stage == "cursor"]
    _, revoked_scope = rows[stage == "lookahead"]
    original = module.snippet
    revoked = False

    def render_then_revoke(text, query):
        nonlocal revoked
        result = original(text, query)
        if text == returned_item["current"]["title"] and not revoked:
            committed_revoke(revoked_scope, users["viewer"])
            revoked = True
        return result

    monkeypatch.setattr(module, "snippet", render_then_revoke)
    with pytest.raises(NotFound):
        search(users["viewer"], "Needle", **options)
    assert revoked
    assert not WorkspaceMember.objects.filter(
        workspace__projects=revoked_scope, user=users["viewer"]
    ).exists()
    monkeypatch.setattr(module, "snippet", original)
    member(users["viewer"], "viewer")
    assert search(users["viewer"], "Needle", **options) == baseline


@pytest.mark.parametrize("transport", ["get", "operation"])
def test_missing_and_forbidden_preview_owners_have_identical_error_responses(
    users, project, transport
):
    _, payload = attachment(users, project, b"Private registered original")
    client = api(users["outsider"])
    missing = {**payload, "item_id": "00000000-0000-0000-0000-000000000000"}
    if transport == "get":
        private_response = client.get("/api/v0/knowledge/preview", payload)
        missing_response = client.get("/api/v0/knowledge/preview", missing)
    else:
        private_response = post_op(client, "knowledge.preview", payload)
        missing_response = post_op(client, "knowledge.preview", missing)
    assert private_response.status_code == missing_response.status_code == 404
    assert private_response.json() == missing_response.json()


@pytest.mark.parametrize("transport", ["get", "operation"])
def test_missing_and_forbidden_exact_search_targets_have_identical_error_responses(
    users, project, transport
):
    private = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace_of(project), "kind": "part", "name": "Protected search target"},
    )
    client = api(users["outsider"])
    target = {"kind": "definition", "definition_id": private["definition_id"]}
    missing = {"kind": "definition", "definition_id": "00000000-0000-0000-0000-000000000000"}
    if transport == "get":
        private_response = client.get(
            "/api/v0/knowledge/search", {"query": "needle", "target": json.dumps(target)}
        )
        missing_response = client.get(
            "/api/v0/knowledge/search", {"query": "needle", "target": json.dumps(missing)}
        )
    else:
        private_response = post_op(
            client, "knowledge.search", {"query": "needle", "target": target}
        )
        missing_response = post_op(
            client, "knowledge.search", {"query": "needle", "target": missing}
        )
    assert private_response.status_code == missing_response.status_code == 404
    assert private_response.json() == missing_response.json()
