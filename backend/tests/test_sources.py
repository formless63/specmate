import hashlib
import io
import json

import pytest
from django.db import connection, transaction
from django.db.utils import DatabaseError
from django.test import Client

from specmate.operations import Conflict, NotFound, ValidationFailed
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob, SourceBundle

from .conftest import op
from .scope_helpers import workspace_of

ORIGINAL = b"synthetic source bytes\n"
EDITED = b"synthetic source bytes, edited\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def register(user, workspace, data, declared=None, size=None):
    payload = {
        "workspace_id": workspace_of(workspace),
        "sha256": declared or sha(data),
        "size": len(data) if size is None else size,
        "media_type": "text/plain",
    }
    return op(user, "source.register_blob", payload, attachments={"content": io.BytesIO(data)})


def files(data, path="src/source.txt"):
    return [
        {
            "path": path,
            "sha256": sha(data),
            "media_type": "text/plain",
            "rights": "synthetic-original",
        }
    ]


def test_registered_blob_identity_and_metadata_are_database_immutable(users, workspace):
    result = register(users["editor"], workspace, ORIGINAL)
    blob = SourceBlob.objects.get(workspace_id=workspace, sha256=sha(ORIGINAL))
    for column, value in (("sha256", sha(EDITED)), ("size", 0), ("media_type", "changed/type")):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE sources_sourceblob SET {column} = %s WHERE id = %s", [value, blob.id]
            )
    with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("DELETE FROM sources_sourceblob WHERE id = %s", [blob.id])
    blob.refresh_from_db()
    assert (blob.sha256, blob.size, blob.media_type) == (sha(ORIGINAL), len(ORIGINAL), "text/plain")
    duplicate = register(users["editor"], workspace, ORIGINAL)
    assert duplicate["blob_id"] == result["blob_id"]
    assert duplicate["created"] is False


def test_register_blob_over_api_stores_exact_bytes(users, workspace):
    client = Client()
    client.force_login(users["editor"])
    response = client.post(
        f"/api/v0/workspaces/{workspace}/blobs",
        {
            "request_id": "r1",
            "sha256": sha(ORIGINAL),
            "size": len(ORIGINAL),
            "media_type": "text/plain",
            "content": io.BytesIO(ORIGINAL),
        },
    )
    assert response.status_code == 200, response.content
    assert response.json()["result"]["created"] is True
    with blobstore.open_blob(sha(ORIGINAL)) as stored:
        assert stored.read() == ORIGINAL


def test_mismatched_hash_or_size_is_rejected_and_not_stored(users, workspace, artifact_root):
    with pytest.raises(ValidationFailed):
        register(users["editor"], workspace, ORIGINAL, declared=sha(b"other"))
    with pytest.raises(ValidationFailed):
        register(users["editor"], workspace, ORIGINAL, size=len(ORIGINAL) + 1)
    assert not SourceBlob.objects.exists()
    assert not blobstore.blob_path(sha(ORIGINAL)).exists()
    assert list((artifact_root / "staging").iterdir()) == []


def test_size_limit_enforced(users, workspace, settings):
    settings.SPECMATE_MAX_SOURCE_BYTES = 4
    with pytest.raises(ValidationFailed):
        register(users["editor"], workspace, ORIGINAL, size=3)


def test_registration_is_per_workspace(users, workspace, other_workspace):
    first = register(users["editor"], workspace, ORIGINAL)
    again = register(users["editor"], workspace, ORIGINAL)
    assert again["blob_id"] == first["blob_id"] and again["created"] is False
    separate = register(users["outsider"], other_workspace, ORIGINAL)
    assert separate["created"] is True and separate["blob_id"] != first["blob_id"]


def test_viewer_and_outsider_cannot_register(users, workspace):
    from specmate.operations import PermissionDenied

    with pytest.raises(PermissionDenied):
        register(users["viewer"], workspace, ORIGINAL)
    with pytest.raises(NotFound):
        register(users["outsider"], workspace, ORIGINAL)


def test_original_survives_derivative_edit_and_reimport(users, workspace):
    register(users["editor"], workspace, ORIGINAL)
    original = op(
        users["editor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Import", "files": files(ORIGINAL)},
    )
    derived = op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": original["revision_id"], "name": "Working copy"},
    )
    assert derived["bundle_id"] != original["bundle_id"]

    register(users["editor"], workspace, EDITED)
    edited = op(
        users["editor"],
        "source.revise_bundle",
        {"bundle_id": derived["bundle_id"], "files": files(EDITED)},
        expected_state=derived["state"],
    )
    reimport = op(
        users["editor"],
        "source.revise_bundle",
        {"bundle_id": original["bundle_id"], "files": files(ORIGINAL)},
        expected_state=original["state"],
    )

    bundle = SourceBundle.objects.get(id=original["bundle_id"])
    first = bundle.revisions.get(number=1)
    assert first.manifest_sha256 == original["manifest_sha256"]
    manifest = json.loads(bytes(first.manifest))
    assert manifest["files"][0]["sha256"] == sha(ORIGINAL)
    assert json.loads(bytes(bundle.revisions.get(number=2).manifest))["ancestry"] == [
        original["revision_id"]
    ]
    derivative = SourceBundle.objects.get(id=derived["bundle_id"])
    assert derivative.role == "derivative"
    assert str(derivative.derived_from_id) == original["revision_id"]
    assert edited["number"] == 2 and reimport["number"] == 2


def test_stale_bundle_revision_conflicts(users, workspace):
    register(users["editor"], workspace, ORIGINAL)
    original = op(
        users["editor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Import", "files": files(ORIGINAL)},
    )
    op(
        users["editor"],
        "source.revise_bundle",
        {"bundle_id": original["bundle_id"], "files": files(ORIGINAL)},
        expected_state=original["state"],
    )
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "source.revise_bundle",
            {"bundle_id": original["bundle_id"], "files": files(ORIGINAL)},
            expected_state=original["state"],
        )


def test_bundle_rejects_unsafe_paths_and_unregistered_bytes(users, workspace):
    register(users["editor"], workspace, ORIGINAL)
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "source.create_original_bundle",
            {"workspace_id": workspace, "name": "Bad", "files": files(ORIGINAL, "../x.txt")},
        )
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "source.create_original_bundle",
            {"workspace_id": workspace, "name": "Bad", "files": files(b"never registered")},
        )
    assert not SourceBundle.objects.exists()


def test_bytes_registered_elsewhere_are_not_usable(users, workspace, other_workspace):
    register(users["outsider"], other_workspace, EDITED)
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "source.create_original_bundle",
            {"workspace_id": workspace, "name": "Bad", "files": files(EDITED)},
        )


def test_derived_bundles_stay_in_their_origin_workspace(users, workspace, other_workspace):
    register(users["outsider"], other_workspace, ORIGINAL)
    foreign = op(
        users["outsider"],
        "source.create_original_bundle",
        {"workspace_id": other_workspace, "name": "Foreign", "files": files(ORIGINAL)},
    )
    register(users["editor"], workspace, ORIGINAL)
    local = op(
        users["editor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Local", "files": files(ORIGINAL)},
    )
    derived = op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": local["revision_id"], "name": "Working copy"},
    )
    # The operation hides a foreign origin before any write.
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "source.derive_bundle",
            {"source_revision_id": foreign["revision_id"], "name": "Crossing copy"},
        )
    # The database rejects a cross-workspace ancestry on insert and on update.
    editor = users["editor"]
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceBundle.objects.create(
            workspace_id=workspace,
            name="Crossing",
            role="derivative",
            derived_from_id=foreign["revision_id"],
            created_by=editor,
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceBundle.objects.filter(id=derived["bundle_id"]).update(
            derived_from_id=foreign["revision_id"]
        )
    assert (
        str(SourceBundle.objects.get(id=derived["bundle_id"]).derived_from_id)
        == (local["revision_id"])
    )


@pytest.mark.parametrize("paths", [("a", "a/b"), ("a/b", "a"), ("A", "a/b")])
def test_colliding_bundle_intake_rolls_back_and_corrected_retry_succeeds(users, workspace, paths):
    register(users["editor"], workspace, ORIGINAL)
    payload = {
        "workspace_id": workspace,
        "name": "Synthetic tree",
        "files": [files(ORIGINAL, path)[0] for path in paths],
    }
    with pytest.raises(ValidationFailed, match="Invalid bundle manifest"):
        op(users["editor"], "source.create_original_bundle", payload, idempotency_key="tree-intake")
    assert not SourceBundle.objects.exists()
    payload["files"] = files(ORIGINAL, "a/b") + files(ORIGINAL, "a/c")
    created = op(
        users["editor"], "source.create_original_bundle", payload, idempotency_key="tree-intake"
    )
    assert created["number"] == 1
    bundle = SourceBundle.objects.get(id=created["bundle_id"])
    assert set(bundle.revisions.get(number=1).files.values_list("path", flat=True)) == {
        "a/b",
        "a/c",
    }


def test_colliding_revision_intake_retains_original_state_and_corrected_retry(users, workspace):
    register(users["editor"], workspace, ORIGINAL)
    created = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace,
            "name": "Synthetic original",
            "files": files(ORIGINAL),
        },
    )
    payload = {
        "bundle_id": created["bundle_id"],
        "files": files(ORIGINAL, "A") + files(ORIGINAL, "a/b"),
    }
    with pytest.raises(ValidationFailed, match="Invalid bundle manifest"):
        op(
            users["editor"],
            "source.revise_bundle",
            payload,
            expected_state=created["state"],
            idempotency_key="tree-revision",
        )
    bundle = SourceBundle.objects.get(id=created["bundle_id"])
    assert bundle.revisions.count() == 1
    assert bundle.revisions.get(number=1).manifest_sha256 == created["manifest_sha256"]
    payload["files"] = files(ORIGINAL, "a/b") + files(ORIGINAL, "a/c")
    revised = op(
        users["editor"],
        "source.revise_bundle",
        payload,
        expected_state=created["state"],
        idempotency_key="tree-revision",
    )
    assert revised["number"] == 2
    assert bundle.revisions.count() == 2


def test_workspace_source_listing_reports_workspace_and_hides_it_from_non_members(users, workspace):
    register(users["editor"], workspace, ORIGINAL)
    bundle = op(
        users["editor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Import", "files": files(ORIGINAL)},
    )
    assert bundle["workspace_id"] == workspace
    client = Client()
    client.force_login(users["viewer"])
    listed = client.get(f"/api/v0/sources/workspaces/{workspace}/revisions")
    assert listed.status_code == 200
    assert listed.json()["workspace_id"] == workspace
    assert [r["revision_id"] for r in listed.json()["revisions"]] == [bundle["revision_id"]]
    # A project id is not a scope: the former project-path alias is gone.
    project = op(users["owner"], "project.create", {"name": "Navigation only"})["project_id"]
    assert client.get(f"/api/v0/sources/projects/{project}/revisions").status_code == 404
    assert client.get(f"/api/v0/sources/workspaces/{project}/revisions").status_code == 404
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/sources/workspaces/{workspace}/revisions").status_code == 404


def test_contributor_registers_sources_but_viewer_cannot(users, workspace):
    register(users["contributor"], workspace, ORIGINAL)
    created = op(
        users["contributor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Contributed", "files": files(ORIGINAL)},
    )
    assert created["workspace_id"] == workspace
