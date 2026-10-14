"""ACC-INT-003: independent declared dimensions, exact pins and authority."""

import copy
import hashlib
from uuid import UUID

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import WorkspaceMember
from specmate.design.models import Snapshot
from specmate.interfaces.queries import inspect_revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
)

from .conftest import ensure_member, op
from .test_interfaces import create, freeze
from .test_shared_read_authority import adopt_with_remote_origin, restore, revoke
from .test_sources import files, register
from .test_transports import api, post_op


@pytest.fixture
def pair(users, project):
    owner = users["owner"]
    body = freeze(
        owner,
        create(
            owner,
            project,
            {
                "kind": "connector_body",
                "contacts": [
                    {"contact_id": "data"},
                    {"contact_id": "ground"},
                    {"contact_id": "screen", "physical_role": "shell"},
                    {"contact_id": "key", "physical_role": "key"},
                ],
            },
        ),
    )
    revisions = []
    for high, current in [(5, 2), (4, 1)]:
        pinout = {
            "kind": "pinout",
            "body_revision_id": body["revision_id"],
            "review": "reviewed",
            "review_basis": "Original synthetic pin table",
            "assignments": [
                {
                    "contact_id": "data",
                    "electrical": {
                        "signal": "bus",
                        "role": "signal",
                        "voltage_min_v": 0,
                        "voltage_max_v": high,
                        "current_max_a": current,
                        "protocol": "synthetic-bus",
                        "basis": "Declared synthetic limits",
                    },
                },
                {"contact_id": "ground", "electrical": {"role": "return"}},
                {"contact_id": "screen", "electrical": {"role": "shield"}},
            ],
        }
        revisions.append(freeze(owner, create(owner, project, pinout)))
    return body, revisions


def assessment(pair):
    _, (left, right) = pair
    return {
        "kind": "interface_assessment",
        "left_pinout_revision_id": left["revision_id"],
        "right_pinout_revision_id": right["revision_id"],
        "mating": {"status": "satisfied", "basis": "Explicit synthetic mating declaration"},
        "pairs": [
            {
                "local_id": "signal",
                "left_contact_id": "data",
                "right_contact_id": "data",
                "expected_signal": "bus",
                "basis": "Proposed original contact correspondence",
            }
        ],
    }


def inspected(users, project, value):
    saved = freeze(users["owner"], create(users["owner"], project, value))
    return saved, inspect_revision(users["viewer"], saved["revision_id"])["assessment"]


def statuses(result):
    return {f["dimension"]: f["status"] for f in result["findings"]}


def test_declared_mating_unknown_ratings_invalid_correspondence_visible_together(
    users, project, pair
):
    value = assessment(pair)
    unknown_pin = {
        "kind": "pinout",
        "body_revision_id": pair[0]["revision_id"],
        "assignments": [{"contact_id": "data", "electrical": {"signal": "other"}}],
    }
    unknown = freeze(users["owner"], create(users["owner"], project, unknown_pin))
    value["right_pinout_revision_id"] = unknown["revision_id"]
    saved, result = inspected(users, project, value)
    assert statuses(result) == {
        "mating": "satisfied",
        "fit": "unknown",
        "pin_correspondence": "invalid",
        "polarity": "unknown",
        "levels": "unknown",
        "current": "unknown",
        "protocol": "unknown",
        "shielding": "unknown",
        "grounding": "unknown",
    }
    pins = next(f for f in result["findings"] if f["dimension"] == "pin_correspondence")
    assert pins["facts"]["pair"]["right_contact_id"] == "data"
    assert pins["facts"]["right"]["voltage_max_v"] is None
    assert pins["facts"]["right"]["current_max_a"] is None
    assert result["physical_qualification"] is False and "compatible" not in result
    assert result["left_pinout_revision_id"] == pair[1][0]["revision_id"]
    client = api(users["viewer"])
    assert (
        client.get(f"/api/v0/interfaces/revisions/{saved['revision_id']}").json()["assessment"]
        == result
    )
    assert (
        post_op(client, "interface.read", {"revision_id": saved["revision_id"]}).json()["result"][
            "assessment"
        ]
        == result
    )


def test_independent_voltage_current_protocol_shield_ground_and_fit_contradictions(
    users, project, pair
):
    value = assessment(pair)
    value["pairs"][0]["operating"] = {
        "voltage_min_v": 0,
        "voltage_max_v": 4,
        "demand_a": 1.25,
        "required_protocol": "other-bus",
        "basis": "Explicit operating envelope",
    }
    value["shielding"] = {
        "left_contact_id": "screen",
        "right_contact_id": "screen",
        "required": "bonded",
        "declared": "bonded",
        "basis": "Declared screen intent",
    }
    value["grounding"] = {
        "left_contact_id": "ground",
        "right_contact_id": "ground",
        "required": "isolated",
        "declared": "bonded",
        "basis": "Contradictory ground intent",
    }
    value["fit"] = {"status": "invalid", "basis": "Declared obstruction, not a measurement"}
    _, result = inspected(users, project, value)
    assert statuses(result) == {
        "mating": "satisfied",
        "fit": "invalid",
        "pin_correspondence": "satisfied",
        "polarity": "unknown",
        "levels": "satisfied",
        "current": "invalid",
        "protocol": "invalid",
        "shielding": "satisfied",
        "grounding": "invalid",
    }
    value["pairs"][0]["operating"].update(
        voltage_max_v=4.1, demand_a=0, required_protocol="synthetic-bus"
    )
    _, changed = inspected(users, project, value)
    assert statuses(changed)["levels"] == "invalid"
    assert statuses(changed)["current"] == statuses(changed)["protocol"] == "satisfied"


def test_missing_operating_inputs_and_unknown_ratings_are_not_defaults(users, project, pair):
    value = assessment(pair)
    _, result = inspected(users, project, value)
    assert all(statuses(result)[key] == "unknown" for key in ("levels", "current", "protocol"))
    right = {
        "kind": "pinout",
        "body_revision_id": pair[0]["revision_id"],
        "assignments": [{"contact_id": "data", "electrical": {"signal": "bus"}}],
    }
    unknown = freeze(users["owner"], create(users["owner"], project, right))
    value["right_pinout_revision_id"] = unknown["revision_id"]
    value["pairs"][0]["operating"] = {
        "voltage_min_v": 0,
        "voltage_max_v": 1,
        "demand_a": 0,
        "required_protocol": "synthetic-bus",
        "basis": "Original zero-load declaration",
    }
    _, result = inspected(users, project, value)
    assert all(statuses(result)[key] == "unknown" for key in ("levels", "current", "protocol"))
    assert statuses(result)["pin_correspondence"] == "satisfied"


def test_invalid_row_does_not_erase_unrelated_rows_and_conditional_limits_stay_unknown(
    users, project, pair
):
    value = assessment(pair)
    value["pairs"][0]["operating"] = {"demand_a": 1, "basis": "Explicit load"}
    value["pairs"].append(
        {
            "local_id": "bad",
            "left_contact_id": "key",
            "right_contact_id": "absent",
            "basis": "Deliberately invalid proposed map",
        }
    )
    _, result = inspected(users, project, value)
    rows = {(f["dimension"], f["pair_id"]): f["status"] for f in result["findings"]}
    assert rows["current", "signal"] == "satisfied"
    assert rows["current", "bad"] == "unknown" and rows["pin_correspondence", "bad"] == "invalid"
    pin = inspect_revision(users["owner"], pair[1][1]["revision_id"])["interface"]
    pin["assignments"][0]["electrical"]["condition"] = "explicit-mode"
    conditional = freeze(users["owner"], create(users["owner"], project, pin))
    value["right_pinout_revision_id"] = conditional["revision_id"]
    _, result = inspected(users, project, value)
    assert (
        next(
            f
            for f in result["findings"]
            if f["dimension"] == "current" and f["pair_id"] == "signal"
        )["status"]
        == "unknown"
    )


def test_saved_assessment_cas_replay_exact_history_and_readonly(users, project, pair):
    owner = users["owner"]
    value = assessment(pair)
    draft = create(owner, project, value, idempotency_key="assessment-create")
    frozen = freeze(owner, draft, idempotency_key="assessment-freeze")
    raw = bytes(Snapshot.objects.get(pk=frozen["snapshot_id"]).canonical)
    assert freeze(owner, draft, idempotency_key="assessment-freeze") == frozen
    changed = copy.deepcopy(value)
    changed["fit"] = {"status": "satisfied", "basis": "Different declared fit"}
    payload = {"draft_id": draft["draft_id"], "interface": changed}
    with pytest.raises(Conflict):
        op(owner, "interface.update", payload, expected_state=draft["state"])
    updated = op(
        owner,
        "interface.update",
        payload,
        expected_state=frozen["draft"]["state"],
        idempotency_key="assessment-update",
    )
    assert (
        op(
            owner,
            "interface.update",
            payload,
            expected_state=frozen["draft"]["state"],
            idempotency_key="assessment-update",
        )
        == updated
    )
    with pytest.raises(IdempotencyMismatch):
        create(owner, project, changed, idempotency_key="assessment-create")
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "interface.update", payload, expected_state=updated["state"])
    with pytest.raises(NotFound):
        inspect_revision(users["outsider"], frozen["revision_id"])
    assert bytes(Snapshot.objects.get(pk=frozen["snapshot_id"]).canonical) == raw
    expected = {UUID(r["revision_id"]) for r in (pair[0], *pair[1])}
    assert (
        set(
            Snapshot.objects.get(pk=frozen["snapshot_id"]).dependencies.values_list(
                "revision_id", flat=True
            )
        )
        == expected
    )


def test_registered_evidence_denial_before_pin_diagnostics_and_replay_recovery(
    users, project, pair
):
    owner = users["owner"]
    remote = op(owner, "project.create", {"name": "Independent evidence scope"})["project_id"]
    register(owner, remote, b"Original inert mating declaration")
    source = op(
        owner,
        "source.create_original_bundle",
        {
            "project_id": remote,
            "name": "Original synthetic declaration",
            "files": files(b"Original inert mating declaration"),
        },
    )
    value = assessment(pair)
    value["mating"]["evidence"] = {
        "status": "registered_file",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "src/source.txt",
    }
    draft = create(owner, project, value, idempotency_key="evidence-create")
    frozen = freeze(owner, draft, idempotency_key="evidence-freeze")
    before = inspect_revision(owner, frozen["revision_id"])
    evidence = before["assessment"]["findings"][0]["evidence"][0]
    assert (
        evidence["sha256"] == hashlib.sha256(b"Original inert mating declaration").hexdigest()
        and evidence["rights"] == "synthetic-original"
        and evidence["source_bundle_revision_id"] == source["revision_id"]
    )
    WorkspaceMember.objects.filter(workspace__projects=remote, user=owner).delete()
    invalid = copy.deepcopy(value)
    invalid["pairs"][0]["right_contact_id"] = "absent"
    for action in (
        lambda: create(owner, project, invalid),
        lambda: create(owner, project, invalid, idempotency_key="evidence-create"),
        lambda: inspect_revision(owner, frozen["revision_id"]),
        lambda: freeze(owner, draft, idempotency_key="evidence-freeze"),
    ):
        with pytest.raises(NotFound):
            action()
    ensure_member(owner, "owner", project=remote)
    assert inspect_revision(owner, frozen["revision_id"]) == before
    assert freeze(owner, draft, idempotency_key="evidence-freeze") == frozen


def test_adopted_pinout_origin_and_captured_actor_apply_to_assessment(users, project, pair):
    remote, _, adopted = adopt_with_remote_origin(users, project, pair[1][1])
    value = assessment(pair)
    value["right_pinout_revision_id"] = adopted["revision_id"]
    frozen, _ = inspected(users, project, value)
    actor = users["viewer"]
    before = inspect_revision(actor, frozen["revision_id"])
    revoke(users, remote)
    with pytest.raises(NotFound):
        inspect_revision(actor, frozen["revision_id"])
    restore(users, remote)
    assert inspect_revision(actor, frozen["revision_id"]) == before
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    with pytest.raises(Unauthenticated):
        inspect_revision(actor, frozen["revision_id"])


def test_declared_non_ground_role_conflicts_with_ground_bond_intent(users, project, pair):
    value = assessment(pair)
    value["grounding"] = {
        "left_contact_id": "data",
        "right_contact_id": "data",
        "required": "bonded",
        "declared": "bonded",
        "basis": "Deliberately wrong ground role",
    }
    _, result = inspected(users, project, value)
    assert statuses(result)["grounding"] == "invalid"
    assert statuses(result)["mating"] == "satisfied"


def test_repeated_contact_proposals_are_retained_as_invalid_not_silently_merged(
    users, project, pair
):
    value = assessment(pair)
    second = copy.deepcopy(value["pairs"][0])
    second["local_id"] = "other-row"
    value["pairs"].append(second)
    saved, result = inspected(users, project, value)
    findings = [f for f in result["findings"] if f["dimension"] == "pin_correspondence"]
    assert [(f["pair_id"], f["status"]) for f in findings] == [
        ("signal", "invalid"),
        ("other-row", "invalid"),
    ]
    assert len(inspect_revision(users["viewer"], saved["revision_id"])["interface"]["pairs"]) == 2


def test_generic_and_named_freeze_share_assessment_bytes_and_validation(users, project, pair):
    value = assessment(pair)
    owner = users["owner"]
    draft = create(owner, project, value)
    typed = freeze(owner, draft)
    generic = op(
        owner,
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=typed["draft"]["state"],
    )
    assert generic["sha256"] == typed["sha256"]
    assert (
        inspect_revision(owner, generic["revision_id"])["assessment"]
        == inspect_revision(owner, typed["revision_id"])["assessment"]
    )
    assert bytes(Snapshot.objects.get(pk=generic["snapshot_id"]).canonical) == bytes(
        Snapshot.objects.get(pk=typed["snapshot_id"]).canonical
    )
