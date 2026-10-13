"""ACC-DOC-002/003: independently scoped closure, rights and offline package checks."""

import base64
import hashlib
import io
import zipfile
from uuid import UUID

import pytest
from django.test import Client, override_settings

from specmate.access.models import Membership
from specmate.design.models import Snapshot
from specmate.operations import (
    Conflict,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord
from specmate.selected_packages import operations  # noqa: F401
from specmate.selected_packages.contracts import Download, Selection
from specmate.selected_packages.queries import archive, build_package
from specmate.selected_packages.verification import verify_files
from specmate.sources import blobstore
from specmate.sources.models import SourceBundle

from .conftest import op
from .test_assemblies import create, endpoint, freeze, occ, part
from .test_cables import capture as freeze_cable
from .test_cables import create as create_cable
from .test_cables import fixture as cable_fixture
from .test_catalog_matching import source_evidence
from .test_transports import api, post_op


def request(root, path=(), **changes):
    return {"root_revision_id": root["revision_id"], "occurrence_path": list(path), **changes}


def package(user, payload):
    reviewed = op(user, "selected_package.review", payload)
    downloaded = op(
        user,
        "selected_package.download",
        {
            **payload,
            "reviewed_sha256": reviewed["sha256"],
        },
    )
    raw = base64.b64decode(downloaded["archive_base64"])
    assert hashlib.sha256(raw).hexdigest() == downloaded["sha256"]
    with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
        files = {path: zipped.read(path) for path in zipped.namelist()}
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in zipped.infolist())
    assert hashlib.sha256(files["manifest.json"]).hexdigest() == reviewed["sha256"]
    return reviewed, downloaded, files


@pytest.fixture
def cable(users, project):
    _, _, stock, body, pins, specification = cable_fixture(users["owner"], project)
    frozen = freeze_cable(users["owner"], create_cable(users["owner"], project, specification))
    return frozen, [frozen, stock, body, pins]


def test_cable_package_opens_locally_exact_hashes_no_parent_sibling_or_labels(
    users, project, cable
):
    selected, required = cable
    _, sibling = part(users["owner"], project, name="SIBLING_SECRET_NAME")
    parent = freeze(
        users["owner"],
        create(
            users["owner"],
            project,
            [occ("chosen", selected, "PARENT_LABEL_SECRET"), occ("unrelated", sibling)],
            [
                {
                    "kind": "electrical",
                    "local_id": "parent-relation-secret",
                    "a": endpoint(["chosen"], "left.a"),
                    "b": endpoint(["unrelated"], "external.pin"),
                }
            ],
        ),
    )
    payload = request(parent, ["chosen"])
    before = {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()}
    reviewed, download, files = package(users["viewer"], payload)
    manifest = reviewed["manifest"]
    expected = {row["revision_id"] for row in required}
    assert {row["revision_id"] for row in manifest["design_revisions"]} == expected
    assert f"designs/{parent['revision_id']}.json" not in files
    assert f"designs/{sibling['revision_id']}.json" not in files
    all_bytes = b"\n".join(files.values())
    for forbidden in (
        b"SIBLING_SECRET_NAME",
        b"PARENT_LABEL_SECRET",
        b"parent-relation-secret",
        b"external.pin",
        b"unrelated",
    ):
        assert forbidden not in all_bytes
    assert manifest["boundary_crossings"] == [
        {
            "kind": "electrical",
            "selected_terminals": [{"path": [], "feature_id": "left.a"}],
            "external": "not_included",
            "external_contract": "unknown",
            "compatibility": "not_evaluated",
            "physical_connectivity": "not_evaluated",
        }
    ]
    assert manifest["occurrences"] == [
        {
            "path": [],
            "revision_id": selected["revision_id"],
            "sha256": selected["sha256"],
            "placement": {"status": "unknown", "frame": "selected_boundary", "unit": "mm"},
            "assignments": {"firmware_revision_id": None},
        }
    ]
    boundary = next(
        row for row in manifest["boundary_interfaces"] if row["kind"] == "cable_endpoints"
    )
    assert [e["local_id"] for e in boundary["endpoints"]] == ["left", "right"]
    assert (
        boundary["endpoints"][0]["pinout"]["assignments"][0]["electrical"]["current_max_a"] is None
    )
    assert {
        t["terminal"]["contact_id"]
        for t in boundary["terminals"]
        if t["terminal"]["kind"] == "contact"
    } == {"a", "b", "shell"}
    assert b"Declared boundary interfaces" in files["review.html"]
    assert b"<script" not in files["review.html"] and b"<img" not in files["review.html"]
    for row in required:
        # Oracle uses original retained bytes, independent of exporter traversal.
        original = before[row["snapshot_id"]]
        assert files[f"designs/{row['revision_id']}.json"] == original
        assert hashlib.sha256(original).hexdigest() == row["sha256"]
    assert verify_files(files, manifest_sha256=reviewed["sha256"]) == []
    assert before == {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()}
    assert download == op(
        users["viewer"],
        "selected_package.download",
        {
            **payload,
            "reviewed_sha256": reviewed["sha256"],
        },
    )
    assert IdempotencyRecord.objects.filter(operation__startswith="selected_package.").count() == 0


def test_repeated_nested_selection_keeps_only_selected_contextual_firmware(users, project):
    _, board = part(users["owner"], project)
    _, fw_a = part(users["owner"], project, "firmware")
    _, fw_b = part(users["owner"], project, "firmware")
    nested = freeze(users["owner"], create(users["owner"], project, [occ("board", board)]))
    root = freeze(
        users["owner"],
        create(
            users["owner"],
            project,
            [occ("a", nested, "same"), occ("b", nested, "same")],
            assignments=[
                {
                    "path": ["a", "board"],
                    "assignments": {"firmware_revision_id": fw_a["revision_id"]},
                },
                {
                    "path": ["b", "board"],
                    "assignments": {"firmware_revision_id": fw_b["revision_id"]},
                },
            ],
        ),
    )
    result, _, files = package(users["owner"], request(root, ["b"]))
    assert {row["revision_id"] for row in result["manifest"]["design_revisions"]} == {
        nested["revision_id"],
        board["revision_id"],
        fw_b["revision_id"],
    }
    assert [row["path"] for row in result["manifest"]["occurrences"]] == [[], ["board"]]
    assert result["manifest"]["occurrences"][1]["assignments"] == {
        "firmware_revision_id": fw_b["revision_id"],
    }
    assert fw_a["revision_id"].encode() not in b"".join(files.values())
    direct = op(users["owner"], "selected_package.review", request(root, ["b", "board"]))
    assert {row["revision_id"] for row in direct["manifest"]["design_revisions"]} == {
        board["revision_id"],
        fw_b["revision_id"],
    }
    assert direct["manifest"]["scope"]["occurrence_path"] == ["b", "board"]
    # Generic/native semantics are explicitly limited, never advertised as tool processing.
    assert direct["manifest"]["completeness"] == "limited"
    assert direct["manifest"]["native_processing"] == "not_performed"


def test_contextual_authority_denial_before_bad_selection_stale_review_and_standalone_independence(
    users,
    project,
    cable,
):
    selected, _ = cable
    remote = op(users["outsider"], "project.create", {"name": "Private context"})["project_id"]
    Membership.objects.create(project_id=remote, user=users["owner"], role="owner")
    Membership.objects.create(project_id=project, user=users["outsider"], role="viewer")
    root = freeze(users["outsider"], create(users["outsider"], remote, [occ("chosen", selected)]))
    review = op(users["owner"], "selected_package.review", request(root, ["chosen"]))
    Membership.objects.filter(project_id=remote, user=users["owner"]).delete()
    for path in (["chosen"], ["missing"]):
        payload = request(root, path, rights_reviews=[{"subject": "wrong", "decision": "unknown"}])
        with pytest.raises(NotFound) as err:
            op(
                users["owner"],
                "selected_package.download",
                {**payload, "reviewed_sha256": "0" * 64},
            )
        assert err.value.details == {}
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "selected_package.download",
            {
                **request(root, ["chosen"]),
                "reviewed_sha256": review["sha256"],
            },
        )
    standalone, _, files = package(users["viewer"], request(selected))
    assert standalone["manifest"]["scope"]["occurrence_path"] == []
    assert root["revision_id"].encode() not in b"".join(files.values())


def source_profile(users, project, stock, evidence):
    draft = op(
        users["owner"],
        "workshop_profile.create",
        {
            "project_id": project,
            "name": "Synthetic profile",
            "profile": {
                "stock_revision_id": stock["revision_id"],
                "foil_visibility": {
                    "value": "hide",
                    "basis": "documented",
                    "source": {
                        "kind": "source_file",
                        "bundle_revision_id": evidence["source_bundle_revision_id"],
                        "path": evidence["source_path"],
                        "sha256": evidence["sha256"],
                        "rights": evidence["rights"],
                    },
                },
            },
        },
    )
    return op(
        users["owner"],
        "workshop_profile.freeze",
        {
            "draft_id": draft["draft_id"],
        },
        expected_state=draft["state"],
    )


def test_exact_source_file_metadata_rights_review_and_no_unrelated_bundle_members(
    users, project, cable
):
    from .test_sources import ORIGINAL, register
    from .test_sources import files as source_entries

    register(users["owner"], project, ORIGINAL)
    bundled = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "SOURCE_BUNDLE_SECRET",
            "files": [
                {**source_entries(ORIGINAL, path="required.txt")[0], "rights": "unknown"},
                *source_entries(ORIGINAL, path="ATTACHMENT_SECRET.txt"),
            ],
        },
    )
    profile = source_profile(
        users,
        project,
        cable[1][1],
        {
            "source_bundle_revision_id": bundled["revision_id"],
            "source_path": "required.txt",
            "sha256": hashlib.sha256(ORIGINAL).hexdigest(),
            "rights": "unknown",
        },
    )
    initial, _, files = package(users["viewer"], request(profile))
    source = initial["manifest"]["source_files"][0]
    assert source["source_path"] == "required.txt" and source["declared_rights"] == "unknown"
    assert source["path"] is None and initial["manifest"]["completeness"] == "limited"
    assert b"ATTACHMENT_SECRET" not in b"".join(files.values())
    assert b"SOURCE_BUNDLE_SECRET" not in b"".join(files.values())
    subject = source["rights_review"]["subject"]
    review = {
        "subject": subject,
        "decision": "permitted",
        "basis": "Reviewed original synthetic bytes",
    }
    inspected, _, included = package(users["owner"], request(profile, rights_reviews=[review]))
    source_path = f"sources/{bundled['revision_id']}/required.txt"
    assert included[source_path] == ORIGINAL
    assert hashlib.sha256(included[source_path]).hexdigest() == source["sha256"]
    assert b"ATTACHMENT_SECRET" not in b"".join(included.values())
    assert verify_files(included, manifest_sha256=inspected["sha256"]) == []
    corrupt = dict(included)
    corrupt[source_path] += b"changed"
    assert "File hash or byte count mismatch." in verify_files(corrupt)
    absent = dict(included)
    del absent[source_path]
    assert "Required source bytes missing or changed." in verify_files(absent)
    # Bytes are checked before being exported, even if a blob row still has its old hash.
    blobstore.blob_path(source["sha256"]).chmod(0o600)
    blobstore.blob_path(source["sha256"]).write_bytes(b"changed")
    with pytest.raises(ValidationFailed, match="integrity"):
        op(users["owner"], "selected_package.review", request(profile, rights_reviews=[review]))


def test_source_ancestry_revocation_hides_diagnostics_and_retained_download(users, project, cable):
    remote = op(users["outsider"], "project.create", {"name": "Restricted original"})["project_id"]
    original = source_evidence(users, project)
    derivative = op(
        users["owner"],
        "source.derive_bundle",
        {
            "source_revision_id": original["source_bundle_revision_id"],
            "name": "Synthetic derivative",
        },
    )
    from .test_sources import ORIGINAL

    profile = source_profile(
        users,
        project,
        cable[1][1],
        {
            "source_bundle_revision_id": derivative["revision_id"],
            "source_path": "src/source.txt",
            "sha256": hashlib.sha256(ORIGINAL).hexdigest(),
            "rights": "synthetic-original",
        },
    )
    payload = request(profile)
    retained = op(users["owner"], "selected_package.review", payload)
    # Transfer the original's authority scope after capture. The derivative itself and
    # its exact selected file stay readable; revoked ancestry must still block export.
    original_bundle = SourceBundle.objects.get(revisions__id=original["source_bundle_revision_id"])
    original_bundle.project_id = UUID(remote)
    original_bundle.save(update_fields=["project"])
    Membership.objects.filter(project_id=remote, user=users["owner"]).delete()
    for sha256 in (retained["sha256"], "0" * 64):
        with pytest.raises(NotFound) as err:
            op(
                users["owner"],
                "selected_package.download",
                {
                    **payload,
                    "reviewed_sha256": sha256,
                    "rights_reviews": [{"subject": "missing-secret-path", "decision": "unknown"}],
                },
            )
        assert err.value.details == {}
    assert post_op(api(users["owner"]), "selected_package.review", payload).status_code == 404


def test_deactivated_actor_blocks_direct_and_shared_retained_package(users, cable):
    payload = request(cable[0])
    reviewed = op(users["owner"], "selected_package.review", payload)
    users["owner"].is_active = False
    users["owner"].save(update_fields=["is_active"])
    for function in (
        lambda: build_package(users["owner"], Selection(**payload)),
        lambda: op(
            users["owner"],
            "selected_package.download",
            {
                **payload,
                "reviewed_sha256": reviewed["sha256"],
            },
        ),
    ):
        with pytest.raises(Unauthenticated):
            function()


def test_distribution_requires_explicit_all_subject_reviews_and_separate_authority(users, cable):
    root, _ = cable
    private = op(users["owner"], "selected_package.review", request(root))
    reviews = [
        {
            "subject": row["rights_review"]["subject"],
            "decision": "permitted",
            "basis": "Original synthetic design owner distribution declaration",
        }
        for row in private["manifest"]["design_revisions"]
    ]
    with pytest.raises(ValidationFailed, match="every subject"):
        op(users["owner"], "selected_package.review", request(root, purpose="distribution"))
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "selected_package.review",
            request(root, purpose="distribution", rights_reviews=reviews),
        )
    result, _, files = package(
        users["owner"], request(root, purpose="distribution", rights_reviews=reviews)
    )
    assert result["manifest"]["rights"] == "explicit_declarations"
    assert verify_files(files, manifest_sha256=result["sha256"]) == []
    with pytest.raises(ValidationFailed, match="withheld"):
        op(
            users["owner"],
            "selected_package.review",
            request(
                root,
                rights_reviews=[
                    {
                        "subject": reviews[0]["subject"],
                        "decision": "withheld",
                        "basis": "Do not include",
                    }
                ],
            ),
        )


def test_review_hash_fresh_authority_no_replay_keys_api_job_and_zip_adapter(users, cable):
    payload = request(cable[0])
    reviewed = op(users["viewer"], "selected_package.review", payload)
    response = post_op(api(users["viewer"]), "selected_package.review", payload)
    assert response.status_code == 200 and response.json()["result"] == reviewed
    with pytest.raises(Conflict):
        op(users["viewer"], "selected_package.download", {**payload, "reviewed_sha256": "0" * 64})
    for name in ("selected_package.review", "selected_package.download"):
        with pytest.raises(ValidationFailed, match="fresh evaluation"):
            op(users["viewer"], name, payload, idempotency_key="no-cached-authority")
    with override_settings(ROOT_URLCONF="tests.selected_packages_urls"):
        client = Client()
        client.force_login(users["viewer"])
        download_payload = {**payload, "reviewed_sha256": reviewed["sha256"]}
        response = client.post(
            "/api/v0/selected-packages/download", download_payload, content_type="application/json"
        )
        assert response.status_code == 200
        raw, _, _ = archive(users["viewer"], Download(**download_payload))
        assert response.content == raw
        assert response["Cache-Control"] == "private, no-store"
        Membership.objects.filter(project_id=cable_project(cable), user=users["viewer"]).delete()
        denied = client.post(
            "/api/v0/selected-packages/download", download_payload, content_type="application/json"
        )
        assert denied.status_code == 404 and denied.json()["error"]["details"] == {}
        client.logout()
        assert (
            client.post(
                "/api/v0/selected-packages/download",
                download_payload,
                content_type="application/json",
            ).status_code
            == 401
        )


def cable_project(cable):
    return Snapshot.objects.get(id=cable[0]["snapshot_id"]).definition.project_id
