"""MEC-004: synthetic canonical placement/mounting declarations, no geometry execution."""

import copy

import pytest

from specmate.access.models import WorkspaceMember
from specmate.assemblies import placement as placement_operations  # noqa: F401
from specmate.design.models import Draft, Snapshot
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_assemblies import create, endpoint, freeze, occ, part
from .test_cables import fixture as cable_fixture
from .test_mechanical_sources import declaration, mec_sources, mec_target  # noqa: F401
from .test_transports import api, post_op


@pytest.fixture
def mounted(users, project):
    _, board = part(users["owner"], project, "board")
    _, enclosure = part(users["owner"], project, "enclosure", "Synthetic enclosure")
    _, hardware = part(users["owner"], project, "hardware", "Synthetic fastener")
    *_, cable_content = cable_fixture(users["owner"], project)
    cable_draft = op(
        users["owner"],
        "cable.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic internal cable",
            "cable": cable_content,
        },
    )
    cable = op(
        users["owner"],
        "cable.freeze",
        {"draft_id": cable_draft["draft_id"]},
        expected_state=cable_draft["state"],
    )
    module = create(users["owner"], project, [occ("board", board)])
    module_revision = freeze(users["owner"], module)
    draft = create(
        users["owner"],
        project,
        [
            occ("left", module_revision, "Module"),
            occ("right", module_revision, "Module"),
            occ("enclosure", enclosure),
            occ("fastener", hardware),
            occ("internal-wire", cable),
        ],
        [
            {
                "kind": "mounting",
                "local_id": "board-support",
                "mounted": endpoint(["right", "board"], "declared-hole-a"),
                "support": endpoint(["enclosure"], "declared-boss-a"),
            },
            {
                "kind": "mounting",
                "local_id": "wire-guide",
                "mounted": endpoint(["internal-wire"]),
                "support": endpoint(["enclosure"]),
            },
            {
                "kind": "mounting",
                "local_id": "fastening",
                "mounted": endpoint(["fastener"]),
                "support": endpoint(["right", "board"]),
            },
        ],
    )
    return draft


def test_current_nested_choices_preserve_exact_context_and_unknown_features(users, mounted):
    result = op(users["viewer"], "assembly.placement_inputs", {"draft_id": mounted["draft_id"]})
    paths = {tuple(row["path"]): row for row in result["occurrences"]}
    left, right = paths[("left", "board")], paths[("right", "board")]
    assert left["revision_id"] == right["revision_id"]
    assert left["snapshot_sha256"] == right["snapshot_sha256"]
    assert left["path"] != right["path"]
    assert right["placement"]["status"] == "unknown"
    assert right["feature_existence"] == "not_evaluated"
    assert result["relationships"][0]["mounted"]["feature_id"] == "declared-hole-a"
    assert result["fit"] == "not_evaluated" and not result["physical_qualification"]


def test_independent_canonical_rotation_and_mounting_persist_in_immutable_history(users, mounted):
    old = freeze(users["owner"], mounted)
    before = bytes(Snapshot.objects.get(id=old["snapshot_id"]).canonical)
    content = copy.deepcopy(old["draft"]["content"]["assembly"])
    content["occurrences"][1]["placement"] = {
        "status": "known",
        "translation": [100, -20.5, 7.25],
        "rotation_xyzw": [0, 0, 1, 0],
    }
    payload = {"draft_id": mounted["draft_id"], "assembly": content}
    updated = op(
        users["owner"],
        "assembly.update",
        payload,
        expected_state=old["draft"]["state"],
        idempotency_key="canonical-placement",
    )
    replay = op(
        users["owner"],
        "assembly.update",
        payload,
        expected_state=old["draft"]["state"],
        idempotency_key="canonical-placement",
    )
    assert replay == updated
    with pytest.raises(Conflict):
        op(users["owner"], "assembly.update", payload, expected_state=old["draft"]["state"])
    frozen = freeze(users["owner"], updated)
    read = op(users["viewer"], "assembly.read", {"snapshot_id": frozen["snapshot_id"]})
    paths = {tuple(row["address"]["path"]): row for row in read["occurrences"]}
    assert paths[("right",)]["placement"]["rotation_xyzw"] == [0, 0, 1, 0]
    assert paths[("right",)]["placement"]["translation"] == [100, -20.5, 7.25]
    assert paths[("left",)]["placement"]["status"] == "unknown"
    assert read["relationships"][0]["mounted"]["path"] == ["right", "board"]
    assert bytes(Snapshot.objects.get(id=old["snapshot_id"]).canonical) == before


@pytest.mark.parametrize(
    "placement",
    [
        {"status": "unknown", "translation": [0, 0, 0]},
        {"status": "known", "translation": [0, 0, 0]},
        {"status": "known", "translation": [0, 0, 0], "rotation_xyzw": [0, 0, 2, 0]},
        {"status": "known", "translation": [True, 0, 0], "rotation_xyzw": [0, 0, 0, 1]},
    ],
)
def test_invalid_placement_rolls_back_without_changing_mounts(users, mounted, placement):
    before = Draft.objects.get(id=mounted["draft_id"])
    content = copy.deepcopy(before.content["assembly"])
    content["occurrences"][0]["placement"] = placement
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "assembly.update",
            {"draft_id": str(before.id), "assembly": content},
            expected_state=before.state_token,
        )
    after = Draft.objects.get(id=before.id)
    assert after.content == before.content and after.version == before.version


def test_current_authority_and_readonly_transport(users, project, mounted):
    response = post_op(
        api(users["viewer"]), "assembly.placement_inputs", {"draft_id": mounted["draft_id"]}
    )
    assert response.status_code == 200
    assert response.json()["result"]["draft_id"] == mounted["draft_id"]
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "assembly.update",
            {"draft_id": mounted["draft_id"], "assembly": mounted["content"]["assembly"]},
            expected_state=mounted["state"],
        )
    assert (
        post_op(
            api(users["outsider"]), "assembly.placement_inputs", {"draft_id": mounted["draft_id"]}
        ).status_code
        == 404
    )
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["viewer"]).delete()
    with pytest.raises(NotFound):
        op(users["viewer"], "assembly.placement_inputs", {"draft_id": mounted["draft_id"]})


def test_lost_membership_hides_mechanical_source_choices_and_saved_mounting(
    users,
    project,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    source = op(
        users["owner"],
        "mechanical_source.create",
        {
            "project_id": project,
            "name": "Synthetic enclosure source",
            "mechanical_source": declaration(mec_sources, mec_target),
        },
    )
    frozen = op(
        users["owner"],
        "mechanical_source.freeze",
        {"draft_id": source["draft_id"]},
        expected_state=source["state"],
    )
    root = create(users["owner"], project, [occ("case", frozen)])
    assert (
        op(users["viewer"], "assembly.placement_inputs", {"draft_id": root["draft_id"]})[
            "occurrences"
        ][0]["name"]
        == "Synthetic enclosure source"
    )
    # Sources share the workspace boundary; losing membership hides the whole closure.
    remove_member(users["viewer"])
    remove_member(users["editor"])
    denied = post_op(
        api(users["viewer"]), "assembly.placement_inputs", {"draft_id": root["draft_id"]}
    )
    assert denied.status_code == 404
    assert "Synthetic enclosure source" not in denied.content.decode()
    assert "occurrences" not in denied.json()
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "assembly.update",
            {
                "draft_id": root["draft_id"],
                "assembly": {"occurrences": [], "relationships": []},
            },
            expected_state="stale",
        )
