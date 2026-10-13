import hashlib
from uuid import UUID

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from specmate.access.models import Membership
from specmate.contracts import SourceBundleManifest
from specmate.design.operations import canonical_bytes
from specmate.operations import NotFound, Unauthenticated
from specmate.queries import get_bundle_revision
from specmate.sources.models import SourceBlob, SourceBundle, SourceBundleFile, SourceBundleRevision

from .conftest import op
from .test_sources import ORIGINAL, files, register


def original(users, project):
    register(users["owner"], project, ORIGINAL)
    return op(
        users["owner"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Manifest authority", "files": files(ORIGINAL)},
    )


def test_manifest_exact_bytes_and_read_only_access(users, project):
    source = original(users, project)
    revision = get_bundle_revision(users["viewer"], UUID(source["revision_id"]))
    client = Client()
    client.force_login(users["viewer"])
    response = client.get(f"/api/v0/bundle-revisions/{revision.id}/manifest")
    assert response.status_code == 200
    assert response.content == bytes(revision.manifest)
    assert hashlib.sha256(response.content).hexdigest() == source["manifest_sha256"]
    with pytest.raises(NotFound):
        get_bundle_revision(users["outsider"], revision.id)


def test_retained_actor_cannot_read_manifest_after_deactivation(users, project):
    source = original(users, project)
    actor = users["viewer"]
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    assert actor.is_active
    with pytest.raises(Unauthenticated):
        get_bundle_revision(actor, UUID(source["revision_id"]))


def test_manifest_checks_valid_cross_project_ancestor_before_disclosure(users, project):
    parent = original(users, project)
    destination = op(users["owner"], "project.create", {"name": "Derivative project"})["project_id"]
    Membership.objects.create(project_id=destination, user=users["viewer"], role="viewer")
    bundle = SourceBundle.objects.create(
        project_id=destination,
        name="Cross-project derivative",
        role="derivative",
        derived_from_id=parent["revision_id"],
        created_by=users["owner"],
    )
    revision = SourceBundleRevision(bundle=bundle, number=1, created_by=users["owner"])
    register(users["owner"], destination, ORIGINAL)
    blob = SourceBlob.objects.get(
        project_id=destination, sha256=hashlib.sha256(ORIGINAL).hexdigest()
    )
    manifest = SourceBundleManifest(
        bundle_id=str(bundle.id),
        source_revision=str(revision.id),
        ancestry=[parent["revision_id"]],
        files=[{**files(ORIGINAL)[0], "bytes": len(ORIGINAL)}],
    )
    data = canonical_bytes(manifest.model_dump(mode="json"))
    revision.manifest = data
    revision.manifest_sha256 = hashlib.sha256(data).hexdigest()
    revision.save()
    SourceBundleFile.objects.create(
        revision=revision,
        path="src/source.txt",
        blob=blob,
        media_type="text/plain",
        rights="synthetic-original",
    )
    client = Client()
    client.force_login(users["viewer"])
    url = f"/api/v0/bundle-revisions/{revision.id}/manifest"
    assert client.get(url).content == data
    Membership.objects.filter(project_id=project, user=users["viewer"]).delete()
    with pytest.raises(NotFound):
        get_bundle_revision(users["viewer"], revision.id)
    response = client.get(url)
    assert response.status_code == 404
    assert data not in response.content
    revision.refresh_from_db()
    assert bytes(revision.manifest) == data
