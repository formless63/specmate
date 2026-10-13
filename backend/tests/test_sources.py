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

ORIGINAL = b"synthetic source bytes\n"
EDITED = b"synthetic source bytes, edited\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def register(user, project, data, declared=None, size=None):
    payload = {
        "project_id": project,
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


def test_registered_blob_identity_and_metadata_are_database_immutable(users, project):
    result = register(users["editor"], project, ORIGINAL)
    blob = SourceBlob.objects.get(project_id=project, sha256=sha(ORIGINAL))
    for column, value in (("sha256", sha(EDITED)), ("size", 0), ("media_type", "changed/type")):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE sources_sourceblob SET {column} = %s WHERE id = %s", [value, blob.id]
            )
    with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("DELETE FROM sources_sourceblob WHERE id = %s", [blob.id])
    blob.refresh_from_db()
    assert (blob.sha256, blob.size, blob.media_type) == (sha(ORIGINAL), len(ORIGINAL), "text/plain")
    duplicate = register(users["editor"], project, ORIGINAL)
    assert duplicate["blob_id"] == result["blob_id"]
    assert duplicate["created"] is False


def test_register_blob_over_api_stores_exact_bytes(users, project):
    client = Client()
    client.force_login(users["editor"])
    response = client.post(
        f"/api/v0/projects/{project}/blobs",
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


def test_mismatched_hash_or_size_is_rejected_and_not_stored(users, project, artifact_root):
    with pytest.raises(ValidationFailed):
        register(users["editor"], project, ORIGINAL, declared=sha(b"other"))
    with pytest.raises(ValidationFailed):
        register(users["editor"], project, ORIGINAL, size=len(ORIGINAL) + 1)
    assert not SourceBlob.objects.exists()
    assert not blobstore.blob_path(sha(ORIGINAL)).exists()
    assert list((artifact_root / "staging").iterdir()) == []


def test_size_limit_enforced(users, project, settings):
    settings.SPECMATE_MAX_SOURCE_BYTES = 4
    with pytest.raises(ValidationFailed):
        register(users["editor"], project, ORIGINAL, size=3)


def test_registration_is_per_project(users, project):
    first = register(users["editor"], project, ORIGINAL)
    again = register(users["editor"], project, ORIGINAL)
    assert again["blob_id"] == first["blob_id"] and again["created"] is False
    other = op(users["outsider"], "project.create", {"name": "Other"})["project_id"]
    separate = register(users["outsider"], other, ORIGINAL)
    assert separate["created"] is True and separate["blob_id"] != first["blob_id"]


def test_viewer_and_outsider_cannot_register(users, project):
    from specmate.operations import PermissionDenied

    with pytest.raises(PermissionDenied):
        register(users["viewer"], project, ORIGINAL)
    with pytest.raises(NotFound):
        register(users["outsider"], project, ORIGINAL)


def test_original_survives_derivative_edit_and_reimport(users, project):
    register(users["editor"], project, ORIGINAL)
    original = op(
        users["editor"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Import", "files": files(ORIGINAL)},
    )
    derived = op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": original["revision_id"], "name": "Working copy"},
    )
    assert derived["bundle_id"] != original["bundle_id"]

    register(users["editor"], project, EDITED)
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


def test_stale_bundle_revision_conflicts(users, project):
    register(users["editor"], project, ORIGINAL)
    original = op(
        users["editor"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Import", "files": files(ORIGINAL)},
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


def test_bundle_rejects_unsafe_paths_and_unregistered_bytes(users, project):
    register(users["editor"], project, ORIGINAL)
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "source.create_original_bundle",
            {"project_id": project, "name": "Bad", "files": files(ORIGINAL, "../x.txt")},
        )
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "source.create_original_bundle",
            {"project_id": project, "name": "Bad", "files": files(b"never registered")},
        )
    assert not SourceBundle.objects.exists()


def test_bytes_registered_elsewhere_are_not_usable(users, project):
    other = op(users["outsider"], "project.create", {"name": "Other"})["project_id"]
    register(users["outsider"], other, EDITED)
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "source.create_original_bundle",
            {"project_id": project, "name": "Bad", "files": files(EDITED)},
        )
