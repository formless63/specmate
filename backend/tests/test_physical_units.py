"""INV-006: actual subjects stay distinct from plans, counts and stock usage."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import DatabaseError, close_old_connections, connection, transaction

from specmate.access.models import WorkspaceMember
from specmate.catalog.models import PhysicalLot
from specmate.inventory.models import StockEntry, WorkBatch
from specmate.inventory.queries import account_detail
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.physical_units.models import PhysicalUnit, WorkUnitLink
from specmate.physical_units.queries import list_units, unit_detail, work_units

from .conftest import op
from .scope_helpers import workspace_of
from .test_design import freeze
from .test_inventory import assertion, open_account, reserve
from .test_transports import api, post_op


@pytest.fixture
def revision(users, definition):
    return freeze(users["owner"], definition["draft_id"], definition["state"])


@pytest.fixture
def actual(users, revision):
    lot = op(
        users["owner"],
        "catalog.register_lot",
        {
            "revision_id": revision["revision_id"],
            "label": "Actual lot A",
        },
    )
    work = op(
        users["owner"],
        "inventory.create_work_batch",
        {
            "revision_id": revision["revision_id"],
            "kind": "batch",
            "label": "Planned six",
            "planned_units": 6,
        },
        idempotency_key="work-six",
    )
    return lot, work


def unit_payload(revision_id, serial, *, lot_id=None, origin="assembled"):
    return {
        "revision_id": revision_id,
        "serial": serial,
        "origin": origin,
        "lot_id": lot_id,
        "assertion_source": "Synthetic bench traveler",
        "assertion_status": "observed",
    }


def link_payload(unit_id, work_batch_id):
    return {
        "unit_id": unit_id,
        "work_batch_id": work_batch_id,
        "assertion_source": "Synthetic build traveler",
        "assertion_status": "declared",
    }


def test_partial_actual_batch_is_separate_from_plan_report_and_stock(
    users, project, revision, actual, workspace
):
    lot, work = actual
    units = [
        op(
            users["owner"],
            "physical_units.register",
            unit_payload(revision["revision_id"], f"UNIT-{n}", lot_id=lot["lot_id"]),
            idempotency_key=f"unit-{n}",
        )
        for n in (1, 2)
    ]
    links = []
    for n, unit in enumerate(units):
        outcome = op(
            users["owner"],
            "physical_units.link_work",
            link_payload(unit["unit_id"], work["work_batch_id"]),
            expected_state=work["state"],
            idempotency_key=f"link-{n}",
        )
        links.append(outcome)
        work = outcome["work_batch"]
    detail = work_units(users["viewer"], work["work_batch_id"])
    assert detail["linked_unit_count"] == 2
    assert detail["work_batch"]["planned_units"] == 6
    assert detail["work_batch"]["reported_completed_units"] == 0
    assert {u["serial"] for u in detail["units"]} == {"UNIT-1", "UNIT-2"}
    assert {u["lot_id"] for u in detail["units"]} == {lot["lot_id"]}
    assert {u["physical_qualification"] for u in detail["units"]} == {False}
    assert {u["work_batch_id"] for u in list_units(users["viewer"], workspace)["units"]} == {
        work["work_batch_id"]
    }
    assert (
        unit_detail(users["viewer"], units[0]["unit_id"])["work_link"]["link_id"]
        == links[0]["link"]["link_id"]
    )
    assert not PhysicalLot.objects.get(id=lot["lot_id"]).stockaccount_set.exists()


def test_replay_conflict_and_current_authority(users, revision, actual, project):
    _, work = actual
    payload = unit_payload(revision["revision_id"], "SERIAL-1")
    one = op(users["owner"], "physical_units.register", payload, idempotency_key="unit-replay")
    assert (
        op(users["owner"], "physical_units.register", payload, idempotency_key="unit-replay") == one
    )
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "physical_units.register",
            unit_payload(revision["revision_id"], "OTHER"),
            idempotency_key="unit-replay",
        )
    with pytest.raises(Conflict):
        op(users["owner"], "physical_units.register", payload, idempotency_key="new-key")
    link = link_payload(one["unit_id"], work["work_batch_id"])
    outcome = op(
        users["owner"],
        "physical_units.link_work",
        link,
        expected_state=work["state"],
        idempotency_key="link-replay",
    )
    assert (
        op(
            users["owner"],
            "physical_units.link_work",
            link,
            expected_state=work["state"],
            idempotency_key="link-replay",
        )
        == outcome
    )
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "physical_units.link_work",
            link,
            expected_state=work["state"],
            idempotency_key="stale-link",
        )
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["owner"]).update(
        role="viewer"
    )
    with pytest.raises(PermissionDenied):
        op(users["owner"], "physical_units.register", payload, idempotency_key="unit-replay")
    with pytest.raises(PermissionDenied):
        op(
            users["owner"],
            "physical_units.link_work",
            link,
            expected_state=work["state"],
            idempotency_key="link-replay",
        )


def test_scope_revision_and_sql_immutability(users, project, revision, actual, workspace):
    _, work = actual
    second = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "part",
            "name": "Other item",
        },
    )
    other_rev = freeze(users["owner"], second["draft_id"], second["state"])
    wrong_lot = op(
        users["owner"],
        "catalog.register_lot",
        {
            "revision_id": other_rev["revision_id"],
            "label": "Other lot",
        },
    )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "physical_units.register",
            unit_payload(revision["revision_id"], "WRONG", lot_id=wrong_lot["lot_id"]),
            idempotency_key="wrong-lot",
        )
    unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(other_rev["revision_id"], "OTHER-UNIT"),
        idempotency_key="other-unit",
    )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "physical_units.link_work",
            link_payload(unit["unit_id"], work["work_batch_id"]),
            expected_state=work["state"],
            idempotency_key="wrong-work",
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        PhysicalUnit.objects.filter(id=unit["unit_id"]).update(serial="REWRITTEN")
    with pytest.raises(DatabaseError), transaction.atomic():
        PhysicalUnit.objects.filter(id=unit["unit_id"]).delete()
    with pytest.raises(DatabaseError), transaction.atomic():
        PhysicalUnit.objects.create(
            workspace_id=workspace,
            revision_id=revision["revision_id"],
            lot_id=wrong_lot["lot_id"],
            serial="RAW-WRONG",
            origin="obtained",
            assertion_source="Raw",
            assertion_status="declared",
            registered_by=users["owner"],
            request_id="raw",
        )
    good = op(
        users["owner"],
        "physical_units.register",
        unit_payload(revision["revision_id"], "GOOD"),
        idempotency_key="good-unit",
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        WorkUnitLink.objects.create(
            unit_id=unit["unit_id"],
            work_batch_id=work["work_batch_id"],
            assertion_source="Raw",
            assertion_status="declared",
            linked_by=users["owner"],
            request_id="raw",
        )
    linked = op(
        users["owner"],
        "physical_units.link_work",
        link_payload(good["unit_id"], work["work_batch_id"]),
        expected_state=work["state"],
        idempotency_key="good-link",
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        WorkUnitLink.objects.filter(id=linked["link"]["link_id"]).update(
            assertion_source="Rewritten"
        )
    assert WorkBatch.objects.get(id=work["work_batch_id"]).state == uuid.UUID(
        linked["work_batch"]["state"]
    )


def test_api_operations_and_scope_closure(users, revision, actual, project, workspace):
    payload = unit_payload(revision["revision_id"], "API-UNIT", origin="obtained")
    forbidden = post_op(
        api(users["viewer"]), "physical_units.register", payload, idempotency_key="api-viewer"
    )
    assert forbidden.status_code == 403
    created = post_op(
        api(users["owner"]), "physical_units.register", payload, idempotency_key="api-owner"
    )
    assert created.status_code == 200 and created.json()["result"]["origin"] == "obtained"
    hidden = users["outsider"]
    with pytest.raises(NotFound):
        unit_detail(hidden, created.json()["result"]["unit_id"])
    with pytest.raises(NotFound):
        list_units(hidden, workspace)


def test_consumption_and_return_preserve_exact_unit_attribution(
    users, project, revision, actual, workspace
):
    lot, work = actual
    location = op(
        users["owner"],
        "inventory.create_location",
        {
            "workspace_id": workspace,
            "name": "Synthetic shelf",
        },
    )
    stock = open_account(users, lot, location)
    held = reserve(users["owner"], stock, idempotency_key="held-for-units")
    unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(revision["revision_id"], "ATTRIBUTED", lot_id=lot["lot_id"]),
        idempotency_key="attributed-unit",
    )
    linked = op(
        users["owner"],
        "physical_units.link_work",
        link_payload(unit["unit_id"], work["work_batch_id"]),
        expected_state=work["state"],
        idempotency_key="attributed-link",
    )
    usage_payload = assertion(
        {"amount": "3", "unit": "ea"},
        reservation_id=held["reservation"]["reservation_id"],
        work_batch_id=work["work_batch_id"],
        physical_unit_id=unit["unit_id"],
        remainder="retain",
        expected_work_state=linked["work_batch"]["state"],
    )
    used = op(
        users["owner"],
        "inventory.consume",
        usage_payload,
        expected_state=held["account"]["state"],
        idempotency_key="unit-consume",
    )
    assert used["consumption"]["physical_unit_id"] == unit["unit_id"]
    assert (
        op(
            users["owner"],
            "inventory.consume",
            usage_payload,
            expected_state=held["account"]["state"],
            idempotency_key="unit-consume",
        )
        == used
    )
    returned = op(
        users["owner"],
        "inventory.return_unused",
        assertion(
            {"amount": "1", "unit": "ea"},
            consumption_id=used["consumption"]["entry_id"],
            expected_work_state=used["work_batch"]["state"],
        ),
        expected_state=used["account"]["state"],
        idempotency_key="unit-return",
    )
    assert returned["return"]["physical_unit_id"] == unit["unit_id"]
    assert [
        (entry["kind"], entry["amount"])
        for entry in unit_detail(users["viewer"], unit["unit_id"])["usage"]
    ] == [("consumption", "3"), ("return", "1")]
    assert (
        account_detail(users["viewer"], stock["account_id"])["entries"][0]["physical_unit_id"]
        == unit["unit_id"]
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        StockEntry.objects.create(
            account_id=stock["account_id"],
            sequence=4,
            kind="return",
            amount=1,
            unit="ea",
            before=8,
            after=9,
            work_batch_id=work["work_batch_id"],
            consumption_origin_id=used["consumption"]["entry_id"],
            physical_unit_id=None,
            reason="Raw attempt",
            assertion_source="Synthetic raw",
            assertion_status="declared",
            actor=users["owner"],
            request_id="raw-return",
        )


def test_unit_attribution_requires_work_link_and_replay_authority(
    users, revision, actual, project, workspace
):
    lot, work = actual
    location = op(
        users["owner"],
        "inventory.create_location",
        {
            "workspace_id": workspace,
            "name": "Synthetic shelf",
        },
    )
    stock = open_account(users, lot, location)
    held = reserve(users["owner"], stock, idempotency_key="held")
    unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(revision["revision_id"], "UNLINKED"),
        idempotency_key="unlinked-unit",
    )
    usage_payload = assertion(
        {"amount": "1", "unit": "ea"},
        reservation_id=held["reservation"]["reservation_id"],
        work_batch_id=work["work_batch_id"],
        physical_unit_id=unit["unit_id"],
        remainder="retain",
        expected_work_state=work["state"],
    )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "inventory.consume",
            usage_payload,
            expected_state=held["account"]["state"],
            idempotency_key="unlinked-consume",
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        StockEntry.objects.create(
            account_id=stock["account_id"],
            sequence=2,
            kind="consumption",
            amount=1,
            unit="ea",
            before=10,
            after=9,
            reservation_id=held["reservation"]["reservation_id"],
            work_batch_id=work["work_batch_id"],
            physical_unit_id=unit["unit_id"],
            reason="Raw attempt",
            assertion_source="Synthetic raw",
            assertion_status="declared",
            actor=users["owner"],
            request_id="raw-consume",
        )
    assert (
        account_detail(users["viewer"], stock["account_id"])["account"]["physical_quantity"] == "10"
    )
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["owner"]).update(
        role="viewer"
    )
    with pytest.raises(PermissionDenied):
        op(
            users["owner"],
            "inventory.consume",
            usage_payload,
            expected_state=held["account"]["state"],
            idempotency_key="unlinked-consume",
        )


def test_serials_are_unique_per_workspace_and_listing_is_workspace_scoped(
    users, workspace, other_workspace, revision
):
    unit = op(
        users["owner"],
        "physical_units.register",
        unit_payload(revision["revision_id"], "SERIAL-1"),
        idempotency_key="serial-1",
    )
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "physical_units.register",
            unit_payload(revision["revision_id"], "SERIAL-1"),
            idempotency_key="serial-1-again",
        )
    listed = list_units(users["contributor"], workspace)
    assert listed["workspace_id"] == workspace and "project_id" not in listed
    assert [u["unit_id"] for u in listed["units"]] == [unit["unit_id"]]
    assert list_units(users["outsider"], other_workspace)["units"] == []
    assert (
        api(users["viewer"]).get(f"/api/v0/physical-units/workspaces/{workspace}").status_code
        == 200
    )
    assert (
        api(users["outsider"]).get(f"/api/v0/physical-units/workspaces/{workspace}").status_code
        == 404
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_workspace_serial_has_one_winner(users, project, revision, workspace):
    gate = Barrier(2)

    def register(n):
        close_old_connections()
        gate.wait()
        try:
            op(
                users["owner"],
                "physical_units.register",
                unit_payload(revision["revision_id"], "SHARED-SERIAL"),
                idempotency_key=f"parallel-{n}",
            )
            return "ok"
        except Conflict:
            return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(register, (1, 2)))
    assert sorted(outcomes) == ["conflict", "ok"]
    assert PhysicalUnit.objects.filter(workspace_id=workspace, serial="SHARED-SERIAL").count() == 1
