"""Actual-unit fact ledgers remain scoped to one immutable physical subject."""

import pytest
from django.db import DatabaseError, transaction

from specmate.access.models import Membership
from specmate.access.permissions import Perm
from specmate.facts.models import FactAssertion, FactSubject
from specmate.facts.queries import read_facts
from specmate.operations import IdempotencyMismatch, NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .test_design import freeze
from .test_facts import fact
from .test_physical_units import unit_payload
from .test_transports import api, post_op


@pytest.fixture
def unit_subjects(users, project, definition):
    revision = freeze(users["owner"], definition["draft_id"], definition["state"])
    units = [
        op(
            users["owner"],
            "physical_units.register",
            unit_payload(revision["revision_id"], f"SERIAL-{n}"),
            idempotency_key=f"subject-unit-{n}",
        )
        for n in (1, 2)
    ]
    targets = [{"kind": "physical_unit", "unit_id": unit["unit_id"]} for unit in units]
    return revision, units, targets


def register(user, target, *, key=None):
    return op(user, "facts.register_subject", {"target": target}, idempotency_key=key)


def measurement():
    return fact(
        "observed_width",
        magnitude="12.5",
        role="actual",
        conditions=[
            {
                "property": "ambient_temperature",
                "status": "known",
                "value": {
                    "kind": "quantity",
                    "dimension": "temperature",
                    "unit": "degC",
                    "magnitude": "22",
                },
            }
        ],
        provenance={
            "method": "measurement",
            "observed_at": "2026-01-01T12:00:00Z",
            "instrument": "Synthetic caliper",
            "procedure": "Synthetic bench procedure; no actual measurement performed by this test.",
            "evidence": [{"kind": "citation", "citation": "Synthetic observation record."}],
        },
    )


def append(user, subject, content, *, key=None):
    return op(
        user,
        "facts.append",
        {"subject_id": subject["subject_id"], "fact": content},
        expected_state=subject["state"],
        idempotency_key=key,
    )


def test_two_units_same_revision_hold_independent_measurements(
    users, project, definition, unit_subjects
):
    revision, units, targets = unit_subjects
    ledgers = [
        register(users["owner"], target, key=f"register-{n}") for n, target in enumerate(targets)
    ]
    assert ledgers[0]["subject_id"] != ledgers[1]["subject_id"]
    assert [ledger["physical_unit_serial"] for ledger in ledgers] == ["SERIAL-1", "SERIAL-2"]
    observed = append(users["owner"], ledgers[0], measurement(), key="measurement-one")
    assert observed["assertion"]["fact"]["provenance"]["method"] == "measurement"
    assert observed["assertion"]["canonical_value"]["magnitude"] == "12.5"
    assert observed["assertion"]["canonical_conditions"][0]["value"]["magnitude"] == "295.15"
    assert (
        read_facts(users["viewer"], ledgers[1]["subject_id"], "observed_width")["assessments"][
            "observed_width"
        ][0]["status"]
        == "unknown"
    )
    later = freeze(users["owner"], definition["draft_id"], revision["draft"]["state"])
    later_unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(later["revision_id"], "SERIAL-LATER"),
        idempotency_key="later-unit",
    )
    later_ledger = register(
        users["owner"], {"kind": "physical_unit", "unit_id": later_unit["unit_id"]}
    )
    assert (
        read_facts(users["viewer"], later_ledger["subject_id"], "observed_width")["assessments"][
            "observed_width"
        ][0]["status"]
        == "unknown"
    )
    assert read_facts(users["viewer"], ledgers[0]["subject_id"])["target"] == targets[0]
    assert FactAssertion.objects.count() == 1
    assert all(unit["physical_qualification"] is False for unit in units)


def test_unit_writes_need_inventory_authority_and_replays_recheck_current_grant(
    users, project, unit_subjects
):
    _, _, targets = unit_subjects
    target = targets[0]
    with pytest.raises(PermissionDenied):
        register(users["viewer"], target)
    assert (
        post_op(api(users["viewer"]), "facts.register_subject", {"target": target}).status_code
        == 403
    )
    Membership.objects.filter(project_id=project, user=users["viewer"]).update(
        grants=[Perm.INVENTORY_MANAGE.value]
    )
    registered = post_op(
        api(users["viewer"]), "facts.register_subject", {"target": target},
        idempotency_key="unit-ledger",
    )
    assert registered.status_code == 200
    ledger = registered.json()["result"]
    assert register(users["viewer"], target, key="unit-ledger") == ledger
    content = measurement()
    observed = append(users["viewer"], ledger, content, key="unit-fact")
    assert append(users["viewer"], ledger, content, key="unit-fact") == observed
    with pytest.raises(IdempotencyMismatch):
        append(users["viewer"], ledger, fact("other", role="actual"), key="unit-fact")
    with pytest.raises(PermissionDenied):
        register(users["viewer"], {"kind": "project", "project_id": project})
    Membership.objects.filter(project_id=project, user=users["viewer"]).update(grants=[])
    with pytest.raises(PermissionDenied):
        register(users["viewer"], target, key="unit-ledger")
    with pytest.raises(PermissionDenied):
        append(users["viewer"], ledger, content, key="unit-fact")
    assert read_facts(users["viewer"], ledger["subject_id"])["physical_unit_serial"] == "SERIAL-1"


def test_unit_subject_scope_guard_immutability_and_measurement_validation(
    users, project, unit_subjects
):
    _, _, targets = unit_subjects
    ledger = register(users["owner"], targets[0])
    other = op(users["owner"], "project.create", {"name": "Other synthetic project"})
    with pytest.raises(DatabaseError), transaction.atomic():
        FactSubject.objects.create(
            project_id=other["project_id"],
            kind="physical_unit",
            physical_unit_id=targets[0]["unit_id"],
            fingerprint="f" * 64,
            registered_by=users["owner"],
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        FactSubject.objects.filter(id=ledger["subject_id"]).update(
            physical_unit_id=targets[1]["unit_id"]
        )
    with pytest.raises(ValidationFailed):
        append(
            users["owner"],
            ledger,
            fact(
                "width",
                role="actual",
                provenance={
                    "method": "measurement",
                    "observed_at": "2026-01-01T12:00:00Z",
                    "procedure": "Synthetic procedure",
                    "evidence": [{"kind": "citation", "citation": "Synthetic"}],
                },
            ),
        )
    with pytest.raises(ValidationFailed):
        append(users["owner"], ledger, fact("width", role="actual", magnitude=0.1))
    assert FactAssertion.objects.count() == 0
    with pytest.raises(NotFound):
        register(users["outsider"], targets[0])
    with pytest.raises(NotFound):
        read_facts(users["outsider"], ledger["subject_id"])
