"""ACC-FW-004: immutable synthetic inputs and observations, real PostgreSQL, inert review."""

import copy
import json
from uuid import uuid4

import pytest

from specmate.access.models import Project
from specmate.design.models import Revision
from specmate.facts.models import FactAssertion
from specmate.firmware_impact import operations  # noqa: F401
from specmate.operations import NotFound, ValidationFailed

from .conftest import member, op, remove_member
from .test_facts import append, fact, subject
from .test_firmware import (  # noqa: F401
    OPT,
    PADS,
    attempt,
    board,
    declaration,
    digest,
    intake,
    recipe,
    source,
    sources,
)
from .test_firmware_occurrences import frozen_firmware, pair  # noqa: F401
from .test_physical_units import unit_payload
from .test_sources import register
from .test_transports import api, post_op


def freeze_firmware(users, project, content):
    draft = op(
        users["owner"],
        "firmware.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic revised controller",
            "firmware": content,
        },
    )
    return op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )


def workspace_of(scope):
    """The workspace id of a project fixture (workspace ids pass through unchanged)."""
    row = Project.objects.filter(id=scope).first()
    return str(row.workspace_id) if row else str(scope)


def payload(project, baseline, candidate, **extra):
    return {
        "workspace_id": workspace_of(project),
        "baseline": {"firmware_revision_id": baseline["revision_id"]},
        "candidate": {"firmware_revision_id": candidate["revision_id"]},
        **extra,
    }


def compare(users, data):
    return op(users["viewer"], "firmware_impact.compare", data)


def observation(users, target):
    """Record a synthetic device-test result.

    A physical measurement attaches only to an actual physical unit; a result recorded on a
    revision, occurrence or project subject is a design-scope reported observation, so it uses the
    source-observation method and carries no instrument metadata.
    """
    ledger = subject(users["owner"], target)
    evidence = [{"kind": "citation", "citation": "Synthetic result"}]
    if target["kind"] == "physical_unit":
        provenance = {
            "method": "measurement",
            "observed_at": "2026-01-01T12:00:00Z",
            "instrument": "Synthetic tester",
            "procedure": "Synthetic test only.",
            "evidence": evidence,
        }
    else:
        provenance = {"method": "source_observation", "evidence": evidence}
    return append(
        users["owner"],
        ledger,
        fact(
            "device_test",
            role="actual",
            value={"kind": "boolean", "value": True},
            provenance=provenance,
        ),
    )["assertion"]


def test_configuration_change_preserves_result_and_original_subject(users, project, sources, board):  # noqa: F811
    first = frozen_firmware(users, project, sources, board)
    second = frozen_firmware(users, project, sources, board, value="900")
    recorded = observation(users, {"kind": "revision", "revision_id": first["revision_id"]})
    before = copy.deepcopy(FactAssertion.objects.get(id=recorded["assertion_id"]).content)
    result = compare(users, payload(project, first, second))
    row = next(r for r in result["findings"] if r["key"] == "configuration.LED_BLINK_MS")
    assert row["status"] == "changed"
    assert row["baseline"]["value"] == "500" and row["candidate"]["value"] == "900"
    assert result["observations"][0]["applicability"] == "review_required"
    assert result["observations"][0]["assertion"]["assertion_id"] == recorded["assertion_id"]
    assert result["observations"][0]["candidate_result"] is None
    assert FactAssertion.objects.get(id=recorded["assertion_id"]).content == before
    assert FactAssertion.objects.count() == 1
    assert not result["historical_results_modified"] and not result["physical_qualification"]
    assert result["compiler_receipts"] == "not_assessed"


def test_pin_change_has_exact_pad_ids_and_review_reason(users, project, sources, board):  # noqa: F811
    first = frozen_firmware(users, project, sources, board)
    content = declaration(sources, board)
    content["pins"][0].update(pad_id=PADS["io4"], expected_net=None, peer_pad_id=None)
    second = freeze_firmware(users, project, content)
    result = compare(users, payload(project, first, second))
    row = next(r for r in result["findings"] if r["key"] == "pins.LED")
    assert row["status"] == "changed"
    assert row["baseline"]["pad_id"] == PADS["io2"]
    assert row["candidate"]["pad_id"] == PADS["io4"]
    assert "review" in row["reason"]
    assert result["hardware_compatibility"] == "not_evaluated"


def test_hardware_population_change_marks_firmware_and_unit_evidence(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
):
    first = frozen_firmware(users, project, sources, board)
    pop_revision = Revision.objects.get(id=board[0]["revision_id"])
    pop_content = json.loads(bytes(pop_revision.snapshot.canonical))["content"]["pcb_population"]
    pop_content["options"][0]["name"] = "Reviewed alternate fitting"
    optional = next(
        row for row in pop_content["options"][0]["decisions"] if row["component_id"] == OPT
    )
    optional.update(status="populate", basis="Deliberately fitted optional synthetic component")
    update = op(
        users["owner"],
        "pcb.population_update",
        {
            "draft_id": board[1]["draft_id"],
            "population": pop_content,
        },
        expected_state=board[0]["draft"]["state"],
    )
    frozen = op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": update["draft_id"]},
        expected_state=update["state"],
    )
    content = declaration(sources, board, population_revision_id=frozen["revision_id"])
    second = freeze_firmware(users, project, content)
    unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(str(pop_revision.id), "SYNTH-IMPACT-UNIT"),
        idempotency_key="register-impact-unit",
    )
    recorded = observation(users, {"kind": "physical_unit", "unit_id": unit["unit_id"]})
    result = compare(users, payload(project, first, second))
    assert (
        next(r for r in result["findings"] if r["key"] == "hardware_target")["status"] == "changed"
    )
    evidence = result["observations"][0]
    assert evidence["subject"]["physical_unit_serial"] == "SYNTH-IMPACT-UNIT"
    assert evidence["applicability"] == "review_required"
    assert evidence["assertion"]["assertion_id"] == recorded["assertion_id"]
    assert "actual physical unit" in evidence["reason"]


def test_same_exact_inputs_retain_unknown_semantics(users, project, sources, board):  # noqa: F811
    frozen = frozen_firmware(users, project, sources, board)
    result = compare(users, payload(project, frozen, frozen))
    assert (
        next(r for r in result["findings"] if r["key"] == "firmware_revision")["status"]
        == "unchanged"
    )
    assert (
        next(r for r in result["findings"] if r["key"] == "configuration.WIFI_PASSWORD")["status"]
        == "unknown"
    )
    assert (
        next(r for r in result["findings"] if r["key"] == "mcu_pin_capability")["status"]
        == "unknown"
    )
    assert result["observations"] == []
    assert result["review_required"] and result["device_operation"] == "not_observed"


def test_unrelated_assertion_is_explicitly_unknown(users, project, sources, board):  # noqa: F811
    frozen = frozen_firmware(users, project, sources, board)
    recorded = observation(users, {"kind": "project", "project_id": project})
    result = compare(
        users, payload(project, frozen, frozen, assertion_ids=[recorded["assertion_id"]])
    )
    assert result["observations"][0]["applicability"] == "unknown"
    assert "not attached" in result["observations"][0]["reason"]


def test_contextual_occurrences_remain_distinct_and_sibling_facts_excluded(users, project, pair):  # noqa: F811
    assembly, first, _ = pair
    frozen = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    snapshot = Revision.objects.get(id=frozen["revision_id"]).snapshot_id
    left = observation(
        users, {"kind": "occurrence", "snapshot_id": str(snapshot), "path": ["left", "board"]}
    )
    right = observation(
        users, {"kind": "occurrence", "snapshot_id": str(snapshot), "path": ["right", "board"]}
    )
    data = payload(project, first, first)
    for name, path in (("baseline", ["left", "board"]), ("candidate", ["right", "board"])):
        data[name].update(assembly_snapshot_id=str(snapshot), path=path)
    result = compare(users, data)
    assert next(r for r in result["findings"] if r["key"] == "occurrence")["status"] == "changed"
    assert [r["assertion"]["assertion_id"] for r in result["observations"]] == [
        left["assertion_id"]
    ]
    assert right["assertion_id"] != left["assertion_id"]


def test_revoked_source_denies_before_unknown_path_diagnostics(users, project, sources, board):  # noqa: F811
    frozen = frozen_firmware(users, project, sources, board)
    data = payload(project, frozen, frozen)
    data["candidate"].update(assembly_snapshot_id=str(uuid4()), path=["missing"])
    # Membership loss is the only revocation: it hides everything before path diagnostics.
    remove_member(users["viewer"], project=project)
    with pytest.raises(NotFound):
        compare(users, data)


def test_http_operation_and_scope_denial(users, project, sources, board):  # noqa: F811
    frozen = frozen_firmware(users, project, sources, board)
    data = payload(project, frozen, frozen)
    response = post_op(api(users["viewer"]), "firmware_impact.compare", data)
    assert response.status_code == 200
    assert (
        response.json()["result"]["comparison_sha256"] == compare(users, data)["comparison_sha256"]
    )
    denied = post_op(api(users["outsider"]), "firmware_impact.compare", data)
    assert denied.status_code == 404
    assert "findings" not in denied.json()
    remove_member(users["viewer"], project=project)
    with pytest.raises(NotFound):
        compare(users, data)


def test_read_cannot_reuse_idempotency_key(users, project, sources, board):  # noqa: F811
    frozen = frozen_firmware(users, project, sources, board)
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "firmware_impact.compare",
            payload(project, frozen, frozen),
            idempotency_key="retained-read",
        )


def test_observation_pagination_preserves_every_result(users, project, sources, board):  # noqa: F811
    frozen = frozen_firmware(users, project, sources, board)
    ids = []
    for number in range(101):
        ledger = subject(
            users["owner"],
            {
                "kind": "revision",
                "revision_id": frozen["revision_id"],
                "feature_id": f"synthetic_case_{number}",
            },
        )
        appended = append(users["owner"], ledger, fact(f"test_{number}"))
        ids.append(appended["assertion"]["assertion_id"])
    data = payload(project, frozen, frozen)
    first = compare(users, data)
    last = compare(users, {**data, "observation_offset": 100})
    assert first["observations_total"] == 101 and first["observations_truncated"]
    assert first["observations_has_more"] and not last["observations_has_more"]
    assert [r["assertion"]["assertion_id"] for r in first["observations"]] == ids[:100]
    assert [r["assertion"]["assertion_id"] for r in last["observations"]] == ids[100:]
    assert FactAssertion.objects.count() == 101


def test_selected_fact_input_source_closure_is_authorized_before_diagnostics(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
):
    frozen = frozen_firmware(users, project, sources, board)
    content = b"Original synthetic observation note."
    register(users["owner"], project, content)
    bundle = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic observation source",
            "files": [
                {
                    "path": "observation.txt",
                    "sha256": digest(content),
                    "media_type": "text/plain",
                    "rights": "CC0-1.0",
                }
            ],
        },
    )
    ledger = subject(users["owner"], {"kind": "project", "project_id": project})
    recorded = append(
        users["owner"],
        ledger,
        fact(
            provenance={
                "method": "source_observation",
                "evidence": [
                    {
                        "kind": "source_file",
                        "bundle_revision_id": bundle["revision_id"],
                        "path": "observation.txt",
                    }
                ],
            }
        ),
    )["assertion"]
    inputs_ledger = subject(
        users["owner"], {"kind": "revision", "revision_id": frozen["revision_id"]}
    )
    derived = append(
        users["owner"],
        inputs_ledger,
        fact(
            "calculated_test",
            provenance={
                "method": "calculation",
                "formula": "x",
                "algorithm_version": "synthetic-v1",
                "evidence": [{"kind": "assertion", "assertion_id": recorded["assertion_id"]}],
            },
        ),
    )["assertion"]
    data = payload(project, frozen, frozen, assertion_ids=[derived["assertion_id"]])
    assert (
        compare(users, data)["observations"][0]["assertion"]["assertion_id"]
        == derived["assertion_id"]
    )
    remove_member(users["viewer"], project=project)
    data["candidate"].update(assembly_snapshot_id=str(uuid4()), path=["private-path"])
    with pytest.raises(NotFound) as error:
        compare(users, data)
    assert "private-path" not in str(error.value) and "observation.txt" not in str(error.value)
    assert FactAssertion.objects.count() == 2


def test_foreign_project_assertion_and_revision_are_scoped_even_for_shared_actor(
    users,
    project,
    other_workspace,
    sources,  # noqa: F811
    board,  # noqa: F811
):
    frozen = frozen_firmware(users, project, sources, board)
    # The outsider records an assertion in a foreign workspace; even an actor who is a
    # member of both workspaces cannot select it or compare in the foreign workspace
    # with this workspace's pins.
    foreign = op(users["outsider"], "project.create", {"name": "Foreign synthetic project"})
    member(users["viewer"], "viewer", workspace=other_workspace)
    ledger = subject(users["outsider"], {"kind": "project", "project_id": foreign["project_id"]})
    recorded = append(users["outsider"], ledger, fact("device_test"))["assertion"]
    with pytest.raises(NotFound):
        compare(users, payload(project, frozen, frozen, assertion_ids=[recorded["assertion_id"]]))
    with pytest.raises(NotFound):
        compare(users, payload(other_workspace, frozen, frozen))
    # A non-member never learns whether the foreign workspace exists or holds the item.
    with pytest.raises(NotFound):
        op(
            users["contributor"],
            "firmware_impact.compare",
            payload(other_workspace, frozen, frozen),
        )


def test_contextual_assignment_mismatch_cannot_borrow_sibling_firmware(users, project, pair):  # noqa: F811
    assembly, first, second = pair
    frozen = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    data = payload(project, first, second)
    data["candidate"].update(assembly_snapshot_id=frozen["snapshot_id"], path=["left", "board"])
    with pytest.raises(ValidationFailed, match="not assigned"):
        compare(users, data)
