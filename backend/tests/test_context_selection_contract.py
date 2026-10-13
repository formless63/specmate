"""Existing scene/resolve/BOM read interoperability on real PostgreSQL.

The accepted extraction fixture is simulated; this test does not run native tools.
"""

from uuid import UUID

import pytest
from django.test import Client

from specmate.bom.queries import inspect_revision
from specmate.design.models import Snapshot
from specmate.operations import NotFound
from specmate.shared_scene import operations  # noqa: F401

from .conftest import op
from .test_assemblies import create, freeze, occ
from .test_assembly_source_authority import sourced_child  # noqa: F401
from .test_bom import capture, policy
from .test_bom import create as create_bom
from .test_mechanical_sources import mec_board  # noqa: F401
from .test_pcb import attempt, intake, recipe, source  # noqa: F401


def test_repeated_native_features_agree_with_resolve_and_frozen_bom_uses(
    users,
    project,
    mec_board,  # noqa: F811
):
    owner, viewer = users["owner"], users["viewer"]
    module = freeze(owner, create(owner, project, [occ("board", mec_board)]))
    root = create(owner, project, [occ(side, module) for side in ("left", "right")])
    frozen = freeze(owner, root)
    plan = {
        "assembly_revision_id": frozen["revision_id"],
        "quantity": {"status": "known", "amount": 2},
        "policies": [policy([], frozen, "make")]
        + [policy([side], module, "make") for side in ("left", "right")]
        + [policy([side, "board"], mec_board, "buy") for side in ("left", "right")],
    }
    bom = capture(owner, create_bom(owner, project, plan), "bom.freeze")
    snapshots = {
        id: bytes(Snapshot.objects.get(id=id).canonical)
        for id in (frozen["snapshot_id"], bom["snapshot_id"])
    }
    scene = op(viewer, "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]})
    boards = [node for node in scene["nodes"] if node["kind"] == "pcb_population"]
    assert [node["address"]["path"] for node in boards] == [["left", "board"], ["right", "board"]]
    native_id = f"component:{UUID(int=2)}"
    for node in boards:
        feature = next(f for f in node["features"] if f["feature_id"] == native_id)
        resolved = op(
            viewer,
            "assembly.resolve",
            {
                "snapshot_id": frozen["snapshot_id"],
                "path": node["address"]["path"],
                "feature_id": native_id,
            },
        )
        assert resolved["address"] == feature["address"]
        assert resolved["revision_id"] == node["revision_id"] == mec_board["revision_id"]
    assert boards[0]["features"][0]["feature_id"] == boards[1]["features"][0]["feature_id"]
    assert boards[0]["features"][0]["address"] != boards[1]["features"][0]["address"]
    contents = inspect_revision(viewer, bom["revision_id"], "assembly_contents")
    board_rows = [row for row in contents["rows"] if row["revision_id"] == mec_board["revision_id"]]
    assert [row["address"] for row in board_rows] == [node["address"] for node in boards]
    assert [row["quantity"]["amount"] for row in board_rows] == [2, 2]
    client = Client()
    client.force_login(viewer)
    assert client.get(f"/api/v0/shared-scenes/snapshots/{frozen['snapshot_id']}").json() == scene
    pin = client.get(f"/api/v0/revisions/{frozen['revision_id']}").json()
    assert pin["snapshot_id"] == scene["snapshot_id"] and pin["sha256"] == scene["sha256"]
    definitions = client.get(f"/api/v0/projects/{project}/definitions").json()
    assert scene["root"]["definition_id"] in {row["definition_id"] for row in definitions}
    assert (
        client.get(f"/api/v0/bom/revisions/{bom['revision_id']}?purpose=assembly_contents").json()
        == contents
    )
    op(
        owner,
        "assembly.update",
        {"draft_id": root["draft_id"], "assembly": {}},
        expected_state=frozen["draft"]["state"],
    )
    assert op(viewer, "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]}) == scene
    assert inspect_revision(viewer, bom["revision_id"], "assembly_contents") == contents
    assert all(
        bytes(Snapshot.objects.get(id=id).canonical) == canonical
        for id, canonical in snapshots.items()
    )


def test_current_source_revocation_denies_every_connected_read_before_context(
    users,
    project,
    sourced_child,  # noqa: F811
):
    module, revoke = sourced_child
    frozen = freeze(users["owner"], create(users["owner"], project, [occ("module", module)]))
    plan = {
        "assembly_revision_id": frozen["revision_id"],
        "quantity": {"status": "known", "amount": 1},
        "policies": [policy([], frozen, "make")],
    }
    bom = capture(users["owner"], create_bom(users["owner"], project, plan), "bom.freeze")
    op(users["viewer"], "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]})
    inspect_revision(users["viewer"], bom["revision_id"], "assembly_contents")
    revoke()
    for operation, payload in [
        ("shared_scene.read", {"snapshot_id": frozen["snapshot_id"]}),
        ("assembly.resolve", {"snapshot_id": frozen["snapshot_id"], "path": ["module", "profile"]}),
    ]:
        with pytest.raises(NotFound):
            op(users["viewer"], operation, payload)
    with pytest.raises(NotFound):
        inspect_revision(users["viewer"], bom["revision_id"], "assembly_contents")
    client = Client()
    client.force_login(users["viewer"])
    for path in [f"revisions/{frozen['revision_id']}", f"bom/revisions/{bom['revision_id']}"]:
        denied = client.get(f"/api/v0/{path}")
        assert denied.status_code == 404 and denied.json()["error"]["details"] == {}


def test_supplemental_needs_keep_the_declared_repeated_native_owner_and_unknown_quantity(
    users,
    project,
    mec_board,  # noqa: F811
):
    """Real operation/API pins; accepted PCB fixture is simulated, not native qualification."""
    from .test_bom import part

    owner, viewer = users["owner"], users["viewer"]
    module = freeze(owner, create(owner, project, [occ("board", mec_board)]))
    frozen = freeze(
        owner, create(owner, project, [occ(side, module) for side in ("left", "right")])
    )
    consumable = part(owner, project, "Synthetic dimensional preparation material")
    plan = {
        "assembly_revision_id": frozen["revision_id"],
        "quantity": {"status": "known", "amount": 2},
        "policies": [policy([], frozen, "make")]
        + [policy([side], module, "make") for side in ("left", "right")]
        + [policy([side, "board"], mec_board, "make") for side in ("left", "right")],
        "needs": [
            {
                "local_id": "left-unknown",
                "context_path": ["left", "board"],
                "revision_id": consumable["revision_id"],
                "purpose": "consumables",
                "quantity": {"status": "unknown", "amount": None, "unit": "m"},
                "basis": "Original synthetic unknown process quantity",
            },
            {
                "local_id": "right-known",
                "context_path": ["right", "board"],
                "revision_id": consumable["revision_id"],
                "purpose": "consumables",
                "quantity": {"status": "known", "amount": "0.125", "unit": "m"},
                "basis": "Original synthetic fractional process quantity",
            },
        ],
    }
    bom = capture(owner, create_bom(owner, project, plan), "bom.freeze")
    scene = op(viewer, "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]})
    result = inspect_revision(viewer, bom["revision_id"], "consumables")
    assert len(result["rows"]) == 2
    actual = {row["need_id"]: row for row in result["rows"]}
    assert actual["left-unknown"]["quantity"] == {"status": "unknown", "amount": None, "unit": "m"}
    assert actual["right-known"]["quantity"] == {"status": "known", "amount": "0.25", "unit": "m"}
    for need in plan["needs"]:
        row = actual[need["local_id"]]
        node = next(
            node for node in scene["nodes"] if node["address"]["path"] == need["context_path"]
        )
        assert row["address"] == node["address"]
        assert row["revision_id"] == consumable["revision_id"] != node["revision_id"]
        component = next(
            feature for feature in node["features"] if feature["role"] == "native_component"
        )
        resolved = op(
            viewer,
            "assembly.resolve",
            {
                "snapshot_id": frozen["snapshot_id"],
                "path": need["context_path"],
                "feature_id": component["feature_id"],
            },
        )
        assert resolved["address"] == component["address"]
        assert resolved["revision_id"] == mec_board["revision_id"]
    client = Client()
    client.force_login(viewer)
    assert (
        client.get(f"/api/v0/bom/revisions/{bom['revision_id']}?purpose=consumables").json()
        == result
    )


def test_accessible_shared_revision_does_not_make_a_foreign_root_a_selected_project_choice(
    users,
    project,
    mec_board,  # noqa: F811
):
    from specmate.access.models import Membership

    owner, viewer = users["owner"], users["viewer"]
    foreign = op(owner, "project.create", {"name": "Synthetic second root project"})["project_id"]
    Membership.objects.create(user=viewer, project_id=foreign, role="viewer")
    frozen = freeze(owner, create(owner, foreign, [occ("board", mec_board)]))
    scene = op(viewer, "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]})
    assert scene["nodes"][0]["revision_id"] == mec_board["revision_id"]
    client = Client()
    client.force_login(viewer)
    original = client.get(f"/api/v0/projects/{project}/definitions").json()
    other = client.get(f"/api/v0/projects/{foreign}/definitions").json()
    assert scene["root"]["definition_id"] not in {row["definition_id"] for row in original}
    assert scene["root"]["definition_id"] in {row["definition_id"] for row in other}
    choices = op(viewer, "shared_scene.list", {"project_id": project})
    assert frozen["snapshot_id"] not in {row["snapshot_id"] for row in choices["assemblies"]}
