"""Same-workspace reuse assessment: frozen firmware in a consuming assembly.

Projects own nothing: the consuming assembly, the firmware and its population all live in
one workspace, and a second project is only navigation context. Cross-workspace isolation
uses the outsider.

These use simulated PCB extraction evidence, not a compiler or physical device.
"""

import copy
from uuid import UUID

import pytest

from specmate.assemblies.queries import get_snapshot
from specmate.design.models import Revision
from specmate.facts.models import FactAssertion
from specmate.firmware_builds.contracts import FirmwareRef
from specmate.firmware_builds.operations import inputs
from specmate.operations import NotFound, ValidationFailed

from .conftest import ensure_member, member, op, remove_member
from .test_assemblies import create, freeze, occ
from .test_facts import append, fact, subject
from .test_firmware import attempt, board, intake, recipe, source, sources  # noqa: F401
from .test_firmware_impact import observation, workspace_of
from .test_firmware_occurrences import frozen_firmware
from .test_physical_units import unit_payload
from .test_sources import register
from .test_transports import api, post_op


@pytest.fixture
def reused(users, project, sources, board):  # noqa: F811
    # Existing fixtures register the exact typed population, source files and firmware.
    firmware = [
        frozen_firmware(users, project, sources, board, value=value) for value in ("500", "900")
    ]
    owning_project = op(users["owner"], "project.create", {"name": "Consumer assembly"})[
        "project_id"
    ]
    ensure_member(users["viewer"], "viewer", project=owning_project)
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
            "workspace_id": workspace_of(project),
            "baseline": references[0],
            "candidate": references[1],
        },
    }


def test_crossproject_assembly_assignment_and_frozen_input_resolver_accept_exact_reuse(
    users, reused
):
    snapshot, closure = get_snapshot(users["viewer"], UUID(reused["frozen"]["snapshot_id"]))
    workspace_id = workspace_of(reused["library"])
    assert str(snapshot.definition.workspace_id) == workspace_id
    for side in ("left", "right"):
        node = closure.nodes[(side,)]
        assert str(node.revision.definition.workspace_id) == workspace_id
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
        assert str(revision.definition.workspace_id) == workspace_id
        assert resolved["occurrence"]["path"] == ref["path"]
        assert resolved["occurrence"]["assembly_snapshot_id"] == reused["frozen"]["snapshot_id"]
        assert resolved["target"]["population_revision_id"] == reused["population"]["revision_id"]


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
    client = api(users["viewer"])
    typed = client.post(
        "/api/v0/firmware-impact/compare", reused["payload"], content_type="application/json"
    )
    generic = post_op(client, "firmware_impact.compare", reused["payload"])
    assert typed.status_code == generic.status_code == 200
    assert typed.json() == generic.json()["result"] == result
    denied = api(users["outsider"]).post(
        "/api/v0/firmware-impact/compare", reused["payload"], content_type="application/json"
    )
    assert denied.status_code == 404 and "findings" not in denied.json()


def test_missing_library_authority_precedes_invalid_context_path(users, reused):
    data = copy.deepcopy(reused["payload"])
    data["candidate"]["path"] = ["unresolved-private-path"]
    with pytest.raises(NotFound, match="Exact frozen board occurrence unavailable"):
        inputs(users["viewer"], FirmwareRef.model_validate(data["candidate"]))
    remove_member(users["viewer"], project=reused["library"])
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(users["viewer"], "firmware_impact.compare", data)


def test_standalone_firmware_and_selected_assertions_are_workspace_scoped(
    users, reused, other_workspace
):
    data = copy.deepcopy(reused["payload"])
    for side in ("baseline", "candidate"):
        data[side] = {"firmware_revision_id": data[side]["firmware_revision_id"]}
    # Standalone reads need no owning project: the workspace holds the firmware.
    result = op(users["viewer"], "firmware_impact.compare", data)
    assert result["workspace_id"] == workspace_of(reused["library"])
    assert result["observations"] == []
    # A deliberately selected workspace assertion is included, wherever it was recorded.
    recorded = observation(users, {"kind": "project", "project_id": reused["owner"]})
    data["assertion_ids"] = [recorded["assertion_id"]]
    selected = op(users["viewer"], "firmware_impact.compare", data)
    assert [r["assertion"]["assertion_id"] for r in selected["observations"]] == [
        recorded["assertion_id"]
    ]
    assert selected["observations"][0]["applicability"] == "unknown"
    # Another workspace never sees these pins, and its member cannot name this workspace.
    foreign = {**data, "workspace_id": other_workspace}
    with pytest.raises(NotFound):
        op(users["outsider"], "firmware_impact.compare", foreign)
    with pytest.raises(NotFound):
        op(users["outsider"], "firmware_impact.compare", data)
    assert all(
        str(Revision.objects.get(id=fw["revision_id"]).definition.workspace_id)
        == workspace_of(reused["library"])
        for fw in reused["firmware"]
    )


def unit_observation(users, revision_id, serial):
    unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(revision_id, serial),
        idempotency_key="unit-" + serial,
    )
    return observation(users, {"kind": "physical_unit", "unit_id": unit["unit_id"]})


def test_exact_revision_facts_and_units_with_those_pins_have_separate_scopes(users, reused):
    expected = [
        observation(
            users, {"kind": "revision", "revision_id": reused["firmware"][0]["revision_id"]}
        ),
        observation(
            users, {"kind": "revision", "revision_id": reused["population"]["revision_id"]}
        ),
        observation(
            users,
            {
                "kind": "occurrence",
                "snapshot_id": reused["frozen"]["snapshot_id"],
                "path": ["left"],
            },
        ),
        unit_observation(users, reused["frozen"]["revision_id"], "SYNTH-CONSUMER-UNIT"),
        # Within one workspace, units built from the baseline's exact population are
        # in scope too; they stay review-required and never transfer to the candidate.
        unit_observation(users, reused["population"]["revision_id"], "SYNTH-LIBRARY-UNIT"),
    ]
    excluded = [
        observation(users, {"kind": "project", "project_id": reused["library"]}),
        observation(
            users, {"kind": "revision", "revision_id": reused["firmware"][1]["revision_id"]}
        ),
        observation(
            users,
            {
                "kind": "occurrence",
                "snapshot_id": reused["frozen"]["snapshot_id"],
                "path": ["right"],
            },
        ),
    ]
    before = {str(row.id): row.content for row in FactAssertion.objects.all()}
    result = op(users["viewer"], "firmware_impact.compare", reused["payload"])
    actual = {row["assertion"]["assertion_id"]: row for row in result["observations"]}
    assert set(actual) == {row["assertion_id"] for row in expected}
    assert not {row["assertion_id"] for row in excluded} & actual.keys()
    for unit_fact in expected[3:]:
        assert actual[unit_fact["assertion_id"]]["applicability"] == "review_required"
    assert all(row["candidate_result"] is None for row in actual.values())
    assert {str(row.id): row.content for row in FactAssertion.objects.all()} == before


def test_selected_extra_assertions_are_deliberate_and_workspace_scoped(
    users, reused, other_workspace
):
    for recorded in (
        unit_observation(users, reused["population"]["revision_id"], "SYNTH-NO-TRANSFER"),
        observation(users, {"kind": "project", "project_id": reused["library"]}),
    ):
        data = {**reused["payload"], "assertion_ids": [recorded["assertion_id"]]}
        selected = op(users["viewer"], "firmware_impact.compare", data)
        row = next(
            r
            for r in selected["observations"]
            if r["assertion"]["assertion_id"] == recorded["assertion_id"]
        )
        assert (
            row["candidate_result"] is None
            and row["applicability"] != "retained_on_original_subject"
        )
    # An assertion recorded in a foreign workspace is unavailable to every actor here.
    foreign_project = op(users["outsider"], "project.create", {"name": "Foreign project"})
    ledger = subject(
        users["outsider"], {"kind": "project", "project_id": foreign_project["project_id"]}
    )
    foreign = append(users["outsider"], ledger, fact("device_test"))["assertion"]
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(
            users["viewer"],
            "firmware_impact.compare",
            {**reused["payload"], "assertion_ids": [foreign["assertion_id"]]},
        )


def test_assigned_firmware_cannot_escape_exact_consumer_snapshot_and_assignment(users, reused):
    data = copy.deepcopy(reused["payload"])
    data["candidate"]["firmware_revision_id"] = reused["firmware"][0]["revision_id"]
    with pytest.raises(ValidationFailed, match="not assigned"):
        op(users["viewer"], "firmware_impact.compare", data)
    foreign = create(
        users["owner"],
        reused["library"],
        [
            occ(
                "board",
                reused["population"],
                assignments={"firmware_revision_id": reused["firmware"][0]["revision_id"]},
            )
        ],
    )
    frozen = freeze(users["owner"], foreign)
    # Another project's frozen assembly in the same workspace is an exact, usable context
    # for the firmware it actually assigns, and for nothing else.
    data["candidate"].update(assembly_snapshot_id=frozen["snapshot_id"], path=["board"])
    result = op(users["viewer"], "firmware_impact.compare", data)
    assert (
        result["candidate"]["inputs"]["occurrence"]["assembly_snapshot_id"]
        == (frozen["snapshot_id"])
    )
    data["candidate"]["firmware_revision_id"] = reused["firmware"][1]["revision_id"]
    with pytest.raises(ValidationFailed, match="not assigned"):
        op(users["viewer"], "firmware_impact.compare", data)


def test_library_revision_fact_input_source_authority_precedes_missing_context_diagnostics(
    users, reused
):
    other = reused["library"]
    raw = b"Synthetic observation input; no physical test."
    import hashlib

    register(users["owner"], other, raw)
    preserved = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "project_id": other,
            "name": "Synthetic dependency evidence",
            "files": [
                {
                    "path": "note.txt",
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "rights": "CC0-1.0",
                    "media_type": "text/plain",
                }
            ],
        },
    )
    ledger = subject(users["owner"], {"kind": "project", "project_id": reused["library"]})
    input_fact = append(
        users["owner"],
        ledger,
        fact(
            provenance={
                "method": "source_observation",
                "evidence": [
                    {
                        "kind": "source_file",
                        "bundle_revision_id": preserved["revision_id"],
                        "path": "note.txt",
                    }
                ],
            }
        ),
    )["assertion"]
    revision_subject = subject(
        users["owner"], {"kind": "revision", "revision_id": reused["firmware"][0]["revision_id"]}
    )
    append(
        users["owner"],
        revision_subject,
        fact(
            "derived_observation",
            provenance={
                "method": "reviewed_association",
                "evidence": [{"kind": "assertion", "assertion_id": input_fact["assertion_id"]}],
            },
        ),
    )
    data = copy.deepcopy(reused["payload"])
    data["candidate"]["path"] = ["unresolved-private-path"]
    remove_member(users["viewer"], project=other)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(users["viewer"], "firmware_impact.compare", data)
    member(users["viewer"], "viewer", project=other)
    with pytest.raises(NotFound, match="Exact frozen board occurrence unavailable"):
        op(users["viewer"], "firmware_impact.compare", data)
    assert (
        op(users["viewer"], "firmware_impact.compare", reused["payload"])["observations_total"] == 1
    )


def test_unit_evidence_chains_are_authorized_without_disclosure_to_non_members(users, reused):
    other = op(users["owner"], "project.create", {"name": "Unrelated unit test inputs"})[
        "project_id"
    ]
    unrelated = observation(users, {"kind": "project", "project_id": other})
    unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(reused["population"]["revision_id"], "SYNTH-OTHER-UNIT"),
        idempotency_key="unrelated-library-unit",
    )
    ledger = subject(users["owner"], {"kind": "physical_unit", "unit_id": unit["unit_id"]})
    append(
        users["owner"],
        ledger,
        fact(
            "unrelated_unit_evidence",
            provenance={
                "method": "reviewed_association",
                "evidence": [{"kind": "assertion", "assertion_id": unrelated["assertion_id"]}],
            },
        ),
    )
    result = op(users["viewer"], "firmware_impact.compare", reused["payload"])
    assert [r["applicability"] for r in result["observations"]] == ["review_required"]
    # The unit's evidence chain is read with fresh workspace authority and never disclosed.
    denied = api(users["outsider"]).post(
        "/api/v0/firmware-impact/compare", reused["payload"], content_type="application/json"
    )
    assert denied.status_code == 404 and "unrelated_unit_evidence" not in denied.text
