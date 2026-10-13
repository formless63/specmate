"""Cross-project reuse assessment: frozen library firmware in an owning assembly.

These use simulated PCB extraction evidence, not a compiler or physical device.
"""

import copy
from uuid import UUID

import pytest

from specmate.access.models import Membership
from specmate.assemblies.queries import get_snapshot
from specmate.design.models import Revision
from specmate.firmware_builds.contracts import FirmwareRef
from specmate.firmware_builds.operations import inputs
from specmate.operations import NotFound

from .conftest import op
from .test_assemblies import create, freeze, occ
from .test_firmware import attempt, board, intake, recipe, source, sources  # noqa: F401
from .test_firmware_impact import observation
from .test_firmware_occurrences import frozen_firmware


@pytest.fixture
def reused(users, project, sources, board):  # noqa: F811
    # Existing fixtures own the exact typed population, source files and firmware in B.
    firmware = [
        frozen_firmware(users, project, sources, board, value=value) for value in ("500", "900")
    ]
    owning_project = op(users["owner"], "project.create", {"name": "Consumer assembly"})[
        "project_id"
    ]
    Membership.objects.create(project_id=owning_project, user=users["viewer"], role="viewer")
    draft = create(
        users["owner"],
        owning_project,
        [
            occ(side, board[0], assignments={"firmware_revision_id": revision["revision_id"]})
            for side, revision in zip(("left", "right"), firmware, strict=True)
        ],
    )
    frozen = freeze(users["owner"], draft)
    references = [
        {
            "firmware_revision_id": revision["revision_id"],
            "assembly_snapshot_id": frozen["snapshot_id"],
            "path": [side],
        }
        for side, revision in zip(("left", "right"), firmware, strict=True)
    ]
    return {
        "library": project,
        "owner": owning_project,
        "firmware": firmware,
        "population": board[0],
        "draft": draft,
        "frozen": frozen,
        "payload": {
            "project_id": owning_project,
            "baseline": references[0],
            "candidate": references[1],
        },
    }


def test_crossproject_assembly_assignment_and_frozen_input_resolver_accept_exact_reuse(
    users, reused
):
    snapshot, closure = get_snapshot(users["viewer"], UUID(reused["frozen"]["snapshot_id"]))
    assert str(snapshot.definition.project_id) == reused["owner"]
    for side in ("left", "right"):
        node = closure.nodes[(side,)]
        assert str(node.revision.definition.project_id) == reused["library"]
        assert str(node.revision.id) == reused["population"]["revision_id"]
    reviewed = op(
        users["viewer"],
        "firmware_occurrence.review",
        {
            "draft_id": reused["draft"]["draft_id"],
            "path": ["left"],
            "firmware_revision_id": reused["firmware"][1]["revision_id"],
        },
    )
    assert reviewed["eligible"]
    assert reviewed["occurrence_revision_id"] == reused["population"]["revision_id"]
    for side in ("baseline", "candidate"):
        ref = reused["payload"][side]
        revision, _, resolved = inputs(users["viewer"], FirmwareRef.model_validate(ref))
        assert str(revision.definition.project_id) == reused["library"]
        assert resolved["occurrence"]["path"] == ref["path"]
        assert resolved["occurrence"]["assembly_snapshot_id"] == reused["frozen"]["snapshot_id"]
        assert resolved["target"]["population_revision_id"] == reused["population"]["revision_id"]


@pytest.mark.xfail(
    strict=True,
    raises=NotFound,
    reason="FW004 currently requires contextual firmware and assembly to share one project",
)
def test_owning_assembly_can_review_reused_firmware_without_transferring_observations(
    users, reused
):
    recorded = observation(
        users,
        {"kind": "occurrence", "snapshot_id": reused["frozen"]["snapshot_id"], "path": ["left"]},
    )
    result = op(users["viewer"], "firmware_impact.compare", reused["payload"])
    assert (
        result["baseline"]["inputs"]["firmware_revision_id"] == reused["firmware"][0]["revision_id"]
    )
    assert (
        result["candidate"]["inputs"]["firmware_revision_id"]
        == reused["firmware"][1]["revision_id"]
    )
    assert [row["assertion"]["assertion_id"] for row in result["observations"]] == [
        recorded["assertion_id"]
    ]
    assert result["observations"][0]["candidate_result"] is None
    assert not result["historical_results_modified"]


def test_missing_library_authority_precedes_invalid_context_path(users, reused):
    data = copy.deepcopy(reused["payload"])
    data["candidate"]["path"] = ["unresolved-private-path"]
    with pytest.raises(NotFound, match="Exact frozen board occurrence unavailable"):
        inputs(users["viewer"], FirmwareRef.model_validate(data["candidate"]))
    Membership.objects.filter(project_id=reused["library"], user=users["viewer"]).delete()
    assert Membership.objects.filter(project_id=reused["owner"], user=users["viewer"]).exists()
    with pytest.raises(NotFound, match=r"^Project not found\.$"):
        op(users["viewer"], "firmware_impact.compare", data)


def test_standalone_foreign_firmware_and_unrelated_assertions_remain_project_scoped(users, reused):
    data = copy.deepcopy(reused["payload"])
    for side in ("baseline", "candidate"):
        data[side] = {"firmware_revision_id": data[side]["firmware_revision_id"]}
    with pytest.raises(NotFound, match="Firmware revision unavailable in this project"):
        op(users["viewer"], "firmware_impact.compare", data)
    data["project_id"] = reused["library"]
    result = op(users["viewer"], "firmware_impact.compare", data)
    assert result["observations"] == []
    recorded = observation(users, {"kind": "project", "project_id": reused["owner"]})
    data["assertion_ids"] = [recorded["assertion_id"]]
    with pytest.raises(NotFound, match="Historical assertion unavailable in this project"):
        op(users["viewer"], "firmware_impact.compare", data)
    assert all(
        str(Revision.objects.get(id=fw["revision_id"]).definition.project_id) == reused["library"]
        for fw in reused["firmware"]
    )
