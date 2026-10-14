"""EVD-001: explicitly recorded assessment/review snapshots, exact pins, staleness, authority."""

import copy

import pytest
from django.db import IntegrityError, InternalError, transaction

from specmate.evidence.models import RecordedPin, RecordedResult
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op, remove_member
from .scope_helpers import workspace_of
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
from .test_firmware_impact import payload
from .test_firmware_occurrences import frozen_firmware
from .test_interface_assessments import assessment, pair  # noqa: F401
from .test_interfaces import create, freeze
from .test_transports import api, post_op


def listing(user, project, **changes):
    return op(user, "evidence.list", {"workspace_id": workspace_of(project), **changes})


def recorded(result):
    return [item for item in result["items"] if item["evidence_id"].startswith("recorded:")]


@pytest.fixture
def frozen_assessment(users, project, pair):  # noqa: F811
    return freeze(users["owner"], create(users["owner"], project, assessment(pair)))


def record_assessment(user, revision, **ctx):
    return op(
        user,
        "evidence.record_interface_assessment",
        {"revision_id": revision["revision_id"]},
        **ctx,
    )


def new_revision(user, frozen, interface):
    draft = frozen["draft"]
    updated = op(
        user,
        "interface.update",
        {"draft_id": draft["draft_id"], "interface": interface},
        expected_state=draft["state"],
    )
    return freeze(user, updated)


def test_reading_never_records_and_recording_is_an_explicit_immutable_snapshot(
    users, project, frozen_assessment
):
    live = op(users["viewer"], "interface.read", {"revision_id": frozen_assessment["revision_id"]})
    assert not RecordedResult.objects.exists()
    assert recorded(listing(users["viewer"], project)) == []

    record = record_assessment(users["contributor"], frozen_assessment)
    assert record["result"] == live
    assert record["kind"] == "generated_check" and record["stale"] is False
    assert record["physical_qualification"] is False and record["rewritten"] is False
    roles = {pin["role"] for pin in record["pins"]}
    assert {"assessment", "left_pinout", "right_pinout", "dependency"} <= roles

    item = recorded(listing(users["viewer"], project))[0]
    assert item["evidence_id"] == f"recorded:{record['record_id']}"
    assert item["kind"] == "generated_check" and item["source"] == "interface_assessment"
    assert item["subject"]["id"] == frozen_assessment["revision_id"]
    assert item["basis"]["origin"] == "recorded_result"
    assert item["basis"]["independently_verified"] is False
    assert f"sha256:{record['result_sha256']}" in item["basis"]["references"]
    assert "no overall compatibility result" in item["statement"]
    assert item["stale"] is False and item["physical_qualification"] is False
    filtered = listing(users["viewer"], project, kinds=["review"])
    assert recorded(filtered) == []

    row = RecordedResult.objects.get(id=record["record_id"])
    with pytest.raises((IntegrityError, InternalError)), transaction.atomic():
        RecordedResult.objects.filter(id=row.id).update(note="rewritten")
    with pytest.raises((IntegrityError, InternalError)), transaction.atomic():
        RecordedPin.objects.filter(record=row).delete()

    client = api(users["viewer"])
    assert client.get(f"/api/v0/evidence/recorded/{record['record_id']}").json() == record


def test_newer_input_revision_marks_record_stale_without_rewriting_it(
    users,
    project,
    pair,  # noqa: F811
    frozen_assessment,
):
    record = record_assessment(users["editor"], frozen_assessment)
    stored = copy.deepcopy(RecordedResult.objects.get(id=record["record_id"]).result)
    _, (left, _) = pair
    pinout = op(users["viewer"], "interface.read", {"revision_id": left["revision_id"]})
    changed = copy.deepcopy(pinout["interface"])
    changed["review_basis"] = "Revised synthetic pin table"
    new_revision(users["owner"], left, changed)

    current = op(users["viewer"], "evidence.read_recorded", {"record_id": record["record_id"]})
    assert current["stale"] is True
    assert current["result"] == stored and current["result_sha256"] == record["result_sha256"]
    left_pin = next(p for p in current["pins"] if p["role"] == "left_pinout")
    assert left_pin["revision_id"] == left["revision_id"]
    assert left_pin["newer_revision_exists"] and left_pin["latest_number"] == 2
    item = recorded(listing(users["viewer"], project))[0]
    assert item["stale"] is True
    assert any(w.startswith("Stale: pinned left pinout revision 1") for w in item["warnings"])
    assert RecordedResult.objects.get(id=record["record_id"]).result == stored


def test_recording_authority_scope_and_idempotency(users, project, frozen_assessment):
    with pytest.raises(PermissionDenied):
        record_assessment(users["viewer"], frozen_assessment)
    with pytest.raises(NotFound):
        record_assessment(users["outsider"], frozen_assessment)
    first = record_assessment(users["contributor"], frozen_assessment, idempotency_key="rec-1")
    assert record_assessment(users["contributor"], frozen_assessment, idempotency_key="rec-1") == (
        first
    )
    assert RecordedResult.objects.count() == 1
    with pytest.raises(IdempotencyMismatch):
        op(
            users["contributor"],
            "evidence.record_interface_assessment",
            {"revision_id": frozen_assessment["revision_id"], "note": "different"},
            idempotency_key="rec-1",
        )
    with pytest.raises(NotFound):
        op(users["outsider"], "evidence.read_recorded", {"record_id": first["record_id"]})
    assert (
        api(users["outsider"]).get(f"/api/v0/evidence/recorded/{first['record_id']}").status_code
        == 404
    )

    # A former member loses the record and its exact inputs; nothing is counted or named.
    remove_member(users["contributor"], project=project)
    with pytest.raises(NotFound):
        op(users["contributor"], "evidence.read_recorded", {"record_id": first["record_id"]})
    with pytest.raises(NotFound):
        record_assessment(users["contributor"], frozen_assessment, idempotency_key="rec-1")


def test_only_assessment_revisions_record_through_the_interface_command(users, project, pair):  # noqa: F811
    body, _ = pair
    with pytest.raises(ValidationFailed, match="interface assessment"):
        record_assessment(users["editor"], body)
    response = post_op(
        api(users["editor"]),
        "evidence.record_interface_assessment",
        {"revision_id": body["revision_id"]},
    )
    assert response.status_code == 422
    assert not RecordedResult.objects.exists()


def test_firmware_impact_record_requires_the_shown_comparison_and_goes_stale(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
):
    first = frozen_firmware(users, project, sources, board)
    second = frozen_firmware(users, project, sources, board, value="900")
    comparison = payload(project, first, second)
    shown = op(users["viewer"], "firmware_impact.compare", comparison)
    assert not RecordedResult.objects.exists()

    with pytest.raises(Conflict):
        op(
            users["contributor"],
            "evidence.record_firmware_impact",
            {"comparison": comparison, "expected_comparison_sha256": "0" * 64},
        )
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "evidence.record_firmware_impact", {"comparison": comparison})
    record = op(
        users["contributor"],
        "evidence.record_firmware_impact",
        {
            "comparison": comparison,
            "expected_comparison_sha256": shown["comparison_sha256"],
            "note": "Synthetic review record",
        },
    )
    assert record["result"] == shown and record["result_sha256"] == shown["comparison_sha256"]
    roles = {pin["role"]: pin["revision_id"] for pin in record["pins"]}
    assert roles["baseline_firmware"] == first["revision_id"]
    assert roles["candidate_firmware"] == second["revision_id"]
    assert "baseline_population" in roles and record["stale"] is False

    item = recorded(listing(users["viewer"], project, kinds=["generated_check"]))[0]
    assert item["source"] == "firmware_impact" and item["status"] == "review_required"
    assert item["subject"]["id"] == second["revision_id"]
    assert item["method"]["name"] == "firmware_impact_comparison"

    content = declaration(sources, board)
    content["configuration"][0]["value"] = "700"
    updated = op(
        users["owner"],
        "firmware.update",
        {"draft_id": second["draft"]["draft_id"], "firmware": content},
        expected_state=second["draft"]["state"],
    )
    op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": updated["draft_id"]},
        expected_state=updated["state"],
    )
    item = recorded(listing(users["viewer"], project))[0]
    assert item["stale"] is True
    assert any("candidate firmware revision 1" in w for w in item["warnings"])
    assert RecordedResult.objects.get(id=record["record_id"]).result == shown


def test_partial_firmware_record_states_its_observation_range():
    from specmate.evidence.recorded import observation_range

    page = {"observations": [{}] * 100, "observations_total": 250, "observation_offset": 100}
    assert observation_range(page) == "101\u2013200 of 250"
    assert observation_range({**page, "observations": [{}] * 50, "observation_offset": 200}) == (
        "201\u2013250 of 250"
    )
    complete = {"observations": [{}] * 3, "observations_total": 3, "observation_offset": 0}
    assert observation_range(complete) is None
