"""Independent scene origin-closure and fresh-actor authority checks."""

from uuid import UUID

import pytest
from django.contrib.auth import get_user_model
from django.test import RequestFactory

from specmate.catalog_packs.models import AdoptionEntry
from specmate.operations import NotFound, Unauthenticated
from specmate.queries import get_draft
from specmate.shared_scene.api import choices, inspect_snapshot

from .conftest import member, op, remove_member
from .scope_helpers import workspace_of
from .test_assemblies import create, freeze, occ, part
from .test_catalog_packs import adopt, install, manifest, registered
from .test_shared_scene import scene


def test_pack_authority_hides_root_and_nested_adoption_then_restores_identical_scenes(
    users, project
):
    original = freeze(users["owner"], create(users["owner"], project))
    # Pack dependencies stay inside the workspace like every other pin.
    hidden = op(users["owner"], "project.create", {"name": "Independent pack dependency"})[
        "project_id"
    ]
    _, external = part(users["owner"], hidden)
    dependency = op(
        users["owner"],
        "catalog_pack.register",
        {
            "project_id": project,
            "manifest": manifest(external, package_key="synthetic.dependency"),
        },
    )
    install(users, dependency)
    version = registered(users, project, original, dependencies=[dependency["version_id"]])
    install(users, version)
    adopt(users, version)
    record = AdoptionEntry.objects.get()
    adopted = freeze(users["owner"], get_draft(users["owner"], record.draft_id))
    nested = freeze(users["owner"], create(users["owner"], project, [occ("adopted", adopted)]))
    expected = [scene(users["viewer"], frozen) for frozen in (adopted, nested)]
    listed = op(users["viewer"], "shared_scene.list", {"workspace_id": workspace_of(project)})
    assert {original["snapshot_id"], adopted["snapshot_id"], nested["snapshot_id"]} <= {
        row["snapshot_id"] for row in listed["assemblies"]
    }
    # Membership loss is the remaining revocation; restoring it restores identical scenes.
    remove_member(users["viewer"])
    for frozen in (adopted, nested):
        with pytest.raises(NotFound):
            scene(users["viewer"], frozen)
    with pytest.raises(NotFound):
        op(users["viewer"], "shared_scene.list", {"workspace_id": workspace_of(project)})
    member(users["viewer"], "viewer")
    assert [scene(users["viewer"], frozen) for frozen in (adopted, nested)] == expected


def test_direct_rest_scene_adapters_reject_deactivated_captured_actor(users, project):
    root = freeze(users["owner"], create(users["owner"], project))
    captured = users["viewer"]
    request = RequestFactory().get("/api/v0/shared-scenes/workspace")
    request.user = captured
    inspect_snapshot(request, UUID(root["snapshot_id"]))
    get_user_model().objects.filter(pk=captured.pk).update(is_active=False)
    assert captured.is_active  # stale caller object is deliberately retained
    with pytest.raises(Unauthenticated):
        choices(request)
    with pytest.raises(Unauthenticated):
        inspect_snapshot(request, UUID(root["snapshot_id"]))
