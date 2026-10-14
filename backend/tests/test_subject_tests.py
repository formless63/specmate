"""EVD-002: tests record procedure, instruments, conditions and the exact actual subject."""
# ruff: noqa: F811

import copy

import pytest
from django.db import IntegrityError, transaction
from pydantic import ValidationError

from specmate.access.models import WorkspaceMember
from specmate.access.permissions import Perm
from specmate.evidence.models import SubjectTest
from specmate.evidence.subject_tests import RecordSubjectTest
from specmate.operations import IdempotencyMismatch, NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_configurations import capture, configuration, option_set, parts  # noqa: F401
from .test_physical_units import actual, link_payload, revision, unit_payload  # noqa: F401
from .test_transports import api, post_op

CONTINUITY = {
    "test_kind": "continuity",
    "procedure": "Synthetic bench continuity procedure; no actual test performed here.",
    "instruments": [
        {"name": "Synthetic meter", "identifier": "M-1", "calibration": "unknown"},
    ],
    "conditions": [
        {
            "property": "ambient_temperature",
            "status": "known",
            "value": {
                "kind": "quantity",
                "dimension": "temperature",
                "unit": "degC",
                "magnitude": "22",
            },
        },
        {"property": "humidity", "status": "unknown"},
    ],
    "observed_at": "2026-01-01T12:00:00Z",
    "criterion": "Every pair of mapped terminals conducts",
    "finding": "criterion_met",
}


def unit(user, revision_id, serial, **changes):
    return op(
        user,
        "physical_units.register",
        {**unit_payload(revision_id, serial), **changes},
        idempotency_key=f"unit-{serial}",
    )


def record(user, subject, *, key=None, **changes):
    return op(
        user,
        "evidence.record_test",
        {**copy.deepcopy(CONTINUITY), "subject": subject, **changes},
        idempotency_key=key,
    )


def on_unit(unit_result):
    return {"kind": "physical_unit", "unit_id": unit_result["unit_id"]}


def listing(user, workspace, **changes):
    return op(user, "evidence.list", {"workspace_id": workspace, **changes})


@pytest.fixture
def units(users, revision):
    return [unit(users["owner"], revision["revision_id"], f"TEST-{n}") for n in "AB"]


def test_a_test_on_unit_a_does_not_qualify_unit_b_of_the_same_revision(
    users, workspace, revision, units
):
    a, b = units
    assert a["revision_id"] == b["revision_id"]
    done = record(users["owner"], on_unit(a), key="a")
    assert done["subject"] == {"kind": "physical_unit", "id": a["unit_id"], "sample_size": None}
    assert done["design_revision_id"] == revision["revision_id"]
    assert done["applies_to"] == "this_subject_only" and done["physical_qualification"] is False

    for_a = listing(users["viewer"], workspace, actual_id=a["unit_id"])["items"]
    for_b = listing(users["viewer"], workspace, actual_id=b["unit_id"])["items"]
    assert [i["evidence_id"] for i in for_a] == [f"test:{done['test_id']}"]
    assert for_b == []
    item = for_a[0]
    assert item["kind"] == "physical_measurement"
    assert item["subject"] == {
        "scope": "actual",
        "kind": "physical_unit",
        "id": a["unit_id"],
        "label": "Physical unit TEST-A",
    }
    assert any("other units of the same design revision" in w for w in item["warnings"])
    assert any("Calibration of Synthetic meter is unknown" in w for w in item["warnings"])
    assert any("tested configuration is unknown" in w for w in item["warnings"])
    assert item["method"]["procedure"] == CONTINUITY["procedure"]
    assert item["method"]["instrument"] == "Synthetic meter"
    assert item["observed_at"].startswith("2026-01-01T12:00:00")
    assert {c["property"]: c["status"] for c in item["conditions"]} == {
        "ambient_temperature": "known",
        "humidity": "unknown",
    }
    assert item["basis"]["independently_verified"] is False
    assert item["physical_qualification"] is False
    assert any("any other unit" in line for line in item["does_not_establish"])
    # The unfiltered workspace view shows exactly one test, on unit A.
    mine = [
        i for i in listing(users["viewer"], workspace)["items"] if i["source"] == "subject_tests"
    ]
    assert [i["subject"]["id"] for i in mine] == [a["unit_id"]]


def test_a_batch_test_is_a_batch_as_a_whole_not_its_member_units(
    users, workspace, revision, actual, units
):
    _, work = actual
    linked = op(
        users["owner"],
        "physical_units.link_work",
        link_payload(units[0]["unit_id"], work["work_batch_id"]),
        expected_state=work["state"],
        idempotency_key="link-a",
    )
    assert linked
    unknown_sample = record(
        users["owner"], {"kind": "work_batch", "work_batch_id": work["work_batch_id"]}
    )
    sampled = record(
        users["owner"],
        {"kind": "work_batch", "work_batch_id": work["work_batch_id"], "sample_size": 3},
    )
    assert unknown_sample["subject"]["sample_size"] is None
    assert sampled["subject"]["sample_size"] == 3
    assert listing(users["viewer"], workspace, actual_id=units[0]["unit_id"])["items"] == []
    batch_items = {
        i["evidence_id"]: i
        for i in listing(users["viewer"], workspace, actual_id=work["work_batch_id"])["items"]
    }
    assert set(batch_items) == {f"test:{unknown_sample['test_id']}", f"test:{sampled['test_id']}"}
    assert all("(as a whole)" in i["subject"]["label"] for i in batch_items.values())
    warn = " ".join(batch_items[f"test:{unknown_sample['test_id']}"]["warnings"])
    assert "sample size not stated" in warn and "does not qualify any individual unit" in warn
    assert "3 unit(s) tested" in " ".join(batch_items[f"test:{sampled['test_id']}"]["warnings"])


def test_the_exact_resolved_configuration_is_recorded_and_stays_in_the_workspace(
    users,
    project,
    workspace,
    units,
    option_set,
    parts,
):
    draft = configuration(users["editor"], project, option_set["revision_id"])
    resolved = capture(users["editor"], draft["draft_id"])
    done = record(
        users["owner"], on_unit(units[0]), configuration_id=resolved["resolved_configuration_id"]
    )
    assert done["configuration_id"] == resolved["resolved_configuration_id"]
    item = listing(users["viewer"], workspace, actual_id=units[0]["unit_id"])["items"][0]
    assert f"configuration:{resolved['resolved_configuration_id']}" in item["basis"]["references"]
    assert not any("configuration is unknown" in w for w in item["warnings"])
    assert any("any other configuration" in line for line in item["does_not_establish"])
    with pytest.raises(NotFound):
        record(
            users["owner"],
            on_unit(units[1]),
            configuration_id="00000000-0000-4000-8000-000000000001",
        )


def test_incomplete_or_incoherent_records_are_rejected_and_leave_nothing(users, units):
    subject = on_unit(units[0])
    bad = [
        {"instruments": []},
        {"procedure": " "},
        {"criterion": ""},
        {"observed_at": "2026-01-01T12:00:00"},
        {"finding": "passed"},
        {"conditions": [CONTINUITY["conditions"][1], CONTINUITY["conditions"][1]]},
        {"conditions": [{"property": "humidity", "status": "known"}]},
        {"instruments": [{"name": "Meter", "calibration": "calibrated"}]},
        {"instruments": [{"name": "Meter", "calibration_reference": "CAL-1"}]},
        {"subject_override": {**subject, "sample_size": 2}},
    ]
    for changes in bad:
        changes = dict(changes)
        target = changes.pop("subject_override", subject)
        with pytest.raises((ValidationFailed, ValidationError)):
            record(users["owner"], target, **changes)
    with pytest.raises(ValidationFailed):
        record(
            users["owner"],
            subject,
            instruments=[{"name": "Meter", "calibration": "uncalibrated"}],
        )
    assert SubjectTest.objects.count() == 0
    with pytest.raises(ValidationError):
        RecordSubjectTest.model_validate(
            {
                **CONTINUITY,
                "subject": {
                    "kind": "work_batch",
                    "work_batch_id": units[0]["unit_id"],
                    "sample_size": 0,
                },
            }
        )
    # An uncalibrated instrument may support an inconclusive result.
    ok = record(
        users["owner"],
        subject,
        instruments=[{"name": "Meter", "calibration": "uncalibrated"}],
        finding="inconclusive",
    )
    assert ok["finding"] == "inconclusive"


def test_authority_replay_and_immutability(users, workspace, units):
    subject = on_unit(units[0])
    with pytest.raises(PermissionDenied):
        record(users["viewer"], subject)
    with pytest.raises(NotFound):
        record(users["outsider"], subject)
    assert (
        post_op(
            api(users["viewer"]), "evidence.record_test", {**CONTINUITY, "subject": subject}
        ).status_code
        == 403
    )
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["viewer"]).update(
        grants=[Perm.INVENTORY_MANAGE.value]
    )
    first = record(users["viewer"], subject, key="same")
    assert record(users["viewer"], subject, key="same") == first
    with pytest.raises(IdempotencyMismatch):
        record(users["viewer"], subject, key="same", criterion="Another criterion")
    assert SubjectTest.objects.count() == 1
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["viewer"]).update(grants=[])
    with pytest.raises((PermissionDenied, NotFound)):
        record(users["viewer"], subject, key="same")

    row = SubjectTest.objects.get()
    for change in (
        lambda: row.__class__.objects.filter(id=row.id).update(finding="criterion_not_met"),
        lambda: row.delete(),
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            change()


def test_reads_are_scoped_and_http_matches_operations(users, workspace, units):
    done = record(users["owner"], on_unit(units[0]))
    read_back = op(users["viewer"], "evidence.read_test", {"test_id": done["test_id"]})
    assert {k: read_back[k] for k in done} == done
    assert read_back["stale"] is False and read_back["warnings"] == []
    with pytest.raises(NotFound):
        op(users["outsider"], "evidence.read_test", {"test_id": done["test_id"]})
    client = api(users["viewer"])
    assert client.get(f"/api/v0/evidence/tests/{done['test_id']}").json() == read_back
    assert (
        api(users["outsider"]).get(f"/api/v0/evidence/tests/{done['test_id']}").status_code == 404
    )
    response = client.get(
        f"/api/v0/evidence/workspaces/{workspace}?actual_id={units[1]['unit_id']}"
    )
    assert response.status_code == 200 and response.json()["items"] == []
    assert (
        listing(users["viewer"], workspace, kinds=["review"], actual_id=units[0]["unit_id"])[
            "items"
        ]
        == []
    )


def test_unit_and_fact_subject_filters_are_exclusive(users, workspace, units):
    with pytest.raises((ValidationFailed, ValidationError)):
        listing(
            users["viewer"],
            workspace,
            actual_id=units[0]["unit_id"],
            subject_id=units[1]["unit_id"],
        )
    assert workspace_of(workspace) == workspace
