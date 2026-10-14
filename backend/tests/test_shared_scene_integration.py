"""Mounted scene reads use registered operations and preserve exact frozen state."""

from specmate.design.models import Snapshot

from .conftest import op
from .scope_helpers import workspace_of
from .test_assemblies import create, freeze, occ, part
from .test_transports import api


def test_registered_scene_and_mounted_reads_match_without_snapshot_writes(users, project):
    owner = users["owner"]
    _, board = part(owner, project)
    frozen = freeze(owner, create(owner, project, [occ("left", board), occ("right", board)]))
    snapshot_id = frozen["snapshot_id"]
    before = list(Snapshot.objects.values())
    expected = op(users["viewer"], "shared_scene.read", {"snapshot_id": snapshot_id})
    response = api(users["viewer"]).get(f"/api/v0/shared-scenes/snapshots/{snapshot_id}")
    assert response.status_code == 200
    assert response.json() == expected
    assert len(expected["nodes"]) == 2
    assert expected["nodes"][0]["node_id"] != expected["nodes"][1]["node_id"]
    assert all(node["world_status"] == "unknown" for node in expected["nodes"])
    assert expected["qualification"]["physical"] is False
    listed = api(users["viewer"]).get("/api/v0/shared-scenes/workspace")
    assert listed.status_code == 200
    assert listed.json() == op(
        users["viewer"], "shared_scene.list", {"workspace_id": workspace_of(project)}
    )
    assert listed.json()["assemblies"][0]["snapshot_id"] == snapshot_id
    assert list(Snapshot.objects.values()) == before
    assert (
        api(users["outsider"]).get(f"/api/v0/shared-scenes/snapshots/{snapshot_id}").status_code
        == 404
    )
    outside = api(users["outsider"]).get(
        f"/api/v0/shared-scenes/workspace?workspace_id={workspace_of(project)}"
    )
    assert outside.status_code == 404
    assert api().get(f"/api/v0/shared-scenes/snapshots/{snapshot_id}").status_code == 401
