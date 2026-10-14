"""INV-001/002: original synthetic dimensional stock and real PostgreSQL contention."""

from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Barrier

import pytest
from django.db import DatabaseError, IntegrityError, close_old_connections, connection, transaction

from specmate.inventory.contracts import ChangeStock
from specmate.inventory.models import Reservation, ReservationRelease, StockAccount, StockEntry
from specmate.inventory.operations import authorize_inventory_replay
from specmate.inventory.queries import account_detail, list_inventory
from specmate.operations import (
    Conflict,
    Context,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op, remove_member, set_grants, set_role
from .scope_helpers import workspace_of
from .test_design import freeze
from .test_transports import api, post_op


@pytest.fixture
def location(users, workspace):
    return op(
        users["owner"],
        "inventory.create_location",
        {"workspace_id": workspace_of(workspace), "name": "Shelf A"},
    )


@pytest.fixture
def lot(users, definition):
    revision = freeze(users["owner"], definition["draft_id"], definition["state"])
    return op(
        users["editor"],
        "catalog.register_lot",
        {"revision_id": revision["revision_id"], "label": "Synthetic batch"},
    )


def assertion(quantity, **extra):
    return {
        "quantity": quantity,
        "reason": "Synthetic stock assertion",
        "assertion_source": "Synthetic receipt record",
        "assertion_status": "declared",
        **extra,
    }


def open_account(users, lot, location, *, dimension="count", amount="10", unit="ea"):
    return op(
        users["owner"],
        "inventory.open_stock",
        assertion(
            {"amount": amount, "unit": unit} if amount is not None else None,
            lot_id=lot["lot_id"],
            location_id=location["location_id"],
            dimension=dimension,
        ),
    )


@pytest.fixture
def stock(users, lot, location):
    return open_account(users, lot, location)


def mutate(user, name, account, quantity, **extra):
    return op(
        user,
        f"inventory.{name}",
        assertion(quantity, account_id=account["account_id"]),
        expected_state=account["state"],
        **extra,
    )


def reserve(user, stock, amount="7", unit="ea", **extra):
    return op(
        user,
        "inventory.reserve",
        {
            "account_id": stock["account_id"],
            "quantity": {"amount": amount, "unit": unit},
            "purpose": "Synthetic build preparation",
        },
        expected_state=stock["state"],
        **extra,
    )


def test_receipts_adjustments_preserve_identity_history_and_original_units(users, lot, location):
    stock = open_account(users, lot, location, dimension="length", amount="250", unit="cm")
    assert stock["physical_quantity"] == stock["available_quantity"] == "2.5"
    stock = mutate(users["owner"], "receive", stock, {"amount": "500", "unit": "mm"})
    stock = mutate(users["owner"], "adjust", stock, {"amount": "-25", "unit": "cm"})
    assert stock["physical_quantity"] == "2.75" and stock["unit"] == "m"
    detail = account_detail(users["viewer"], stock["account_id"])
    assert [(entry["kind"], entry["amount"], entry["unit"]) for entry in detail["entries"]] == [
        ("adjustment", "-25", "cm"),
        ("receipt", "500", "mm"),
        ("opening", "250", "cm"),
    ]
    assert all(
        entry["assertion_source"] == "Synthetic receipt record" for entry in detail["entries"]
    )
    assert all(entry["assertion_status"] == "declared" for entry in detail["entries"])
    assert stock["lot_id"] == lot["lot_id"] and stock["revision_id"] == lot["revision_id"]
    with pytest.raises(ValidationFailed):
        reserve(users["owner"], stock, "1", "ea")
    with pytest.raises(ValidationFailed):
        mutate(users["owner"], "receive", stock, {"amount": "1", "unit": "kg"})
    assert StockEntry.objects.count() == 3


def test_unknown_is_not_zero_or_available_and_observation_preserves_unknown_origin(
    users, lot, location
):
    stock = open_account(users, lot, location, dimension="mass", amount=None)
    assert stock["quantity_status"] == "unknown"
    assert stock["physical_quantity"] is stock["available_quantity"] is None
    with pytest.raises(Conflict):
        reserve(users["owner"], stock, "1", "g")
    with pytest.raises(Conflict):
        mutate(users["owner"], "receive", stock, {"amount": "1", "unit": "kg"})
    stock = mutate(users["owner"], "establish_quantity", stock, {"amount": "1200", "unit": "g"})
    assert stock["physical_quantity"] == "1.2" and stock["quantity_status"] == "known"
    detail = account_detail(users["owner"], stock["account_id"])
    assert detail["entries"][0]["before"] is None
    result = reserve(users["owner"], stock, "200", "g")
    assert result["account"]["available_quantity"] == "1"
    assert result["account"]["physical_quantity"] == "1.2"


def test_reservation_release_never_consumes_and_adjustment_cannot_spend_reserved(users, stock):
    result = reserve(users["owner"], stock)
    assert result["account"]["physical_quantity"] == "10"
    assert result["account"]["reserved_quantity"] == "7"
    assert result["account"]["available_quantity"] == "3"
    with pytest.raises(Conflict):
        mutate(users["owner"], "adjust", result["account"], {"amount": "-4", "unit": "ea"})
    with pytest.raises(Conflict):
        reserve(users["owner"], result["account"], "4")
    released = op(
        users["owner"],
        "inventory.release",
        {"reservation_id": result["reservation"]["reservation_id"], "reason": "Build postponed"},
        expected_state=result["account"]["state"],
    )
    assert released["reservation"]["status"] == "released"
    assert (
        released["account"]["physical_quantity"]
        == released["account"]["available_quantity"]
        == "10"
    )
    assert released["account"]["reserved_quantity"] == "0"
    assert StockEntry.objects.count() == 1
    assert (
        account_detail(users["viewer"], stock["account_id"])["reservations"][0]["release"]["reason"]
        == "Build postponed"
    )


@pytest.mark.parametrize(
    "quantity",
    [
        {"amount": "1.5", "unit": "ea"},
        {"amount": "NaN", "unit": "ea"},
        {"amount": "0.000000001", "unit": "mm"},
        {"amount": "1", "unit": "L"},
        {"amount": "1000000000000000", "unit": "ea"},
    ],
)
def test_invalid_quantities_do_not_append(users, stock, quantity):
    with pytest.raises(ValidationFailed):
        mutate(users["owner"], "receive", stock, quantity)
    assert StockEntry.objects.count() == 1


def test_negative_stock_and_zero_changes_rejected(users, stock):
    for name, quantity in [
        ("adjust", "-11"),
        ("adjust", "0"),
        ("receive", "-1"),
        ("receive", "0"),
        ("establish_quantity", "-1"),
    ]:
        with pytest.raises(ValidationFailed):
            mutate(users["owner"], name, stock, {"amount": quantity, "unit": "ea"})
    assert StockEntry.objects.count() == 1
    zero = mutate(users["owner"], "establish_quantity", stock, {"amount": "0", "unit": "ea"})
    assert zero["quantity_status"] == "known" and zero["physical_quantity"] == "0"


def test_permissions_and_scoped_api_reads_writes(users, workspace, stock):
    payload = assertion({"amount": "1", "unit": "ea"}, account_id=stock["account_id"])
    for name, error, status in [
        ("editor", PermissionDenied, 403),
        ("contributor", PermissionDenied, 403),
        ("viewer", PermissionDenied, 403),
        ("outsider", NotFound, 404),
    ]:
        with pytest.raises(error):
            mutate(users[name], "receive", stock, payload["quantity"])
        assert (
            post_op(
                api(users[name]), "inventory.receive", payload, expected_state=stock["state"]
            ).status_code
            == status
        )
    assert (
        post_op(api(), "inventory.receive", payload, expected_state=stock["state"]).status_code
        == 401
    )
    # Editors reserve by role; contributors and viewers cannot, and no grant adds it.
    with pytest.raises(IntegrityError), transaction.atomic():
        set_grants(users["viewer"], ["inventory.reserve"])
    for name in ("viewer", "contributor"):
        with pytest.raises(PermissionDenied):
            reserve(users[name], stock)
    result = reserve(users["editor"], stock)
    with pytest.raises(PermissionDenied):
        mutate(users["editor"], "receive", result["account"], payload["quantity"])
    set_grants(users["editor"], ["inventory.manage"])
    received = mutate(users["editor"], "receive", result["account"], payload["quantity"])
    reserved = reserve(users["editor"], received, "1")
    assert reserved["account"]["reserved_quantity"] == "8"
    # inventory.manage implies reserving even for a role that lacks it.
    set_grants(users["contributor"], ["inventory.manage"])
    implied = reserve(users["contributor"], reserved["account"], "1")
    assert implied["account"]["reserved_quantity"] == "9"
    url = f"/api/v0/inventory/workspaces/{workspace}"
    assert api(users["viewer"]).get(url).json()["accounts"][0]["physical_quantity"] == "11"
    assert api(users["viewer"]).get(url + "?offset=1&limit=1").json()["accounts"] == []
    assert api(users["viewer"]).get(url + "?limit=101").status_code == 422
    assert api(users["outsider"]).get(url).status_code == 404
    assert api().get(url).status_code == 401
    assert (
        api(users["outsider"]).get(f"/api/v0/inventory/accounts/{stock['account_id']}").status_code
        == 404
    )


def test_idempotency_and_state_conflict(users, stock):
    result = reserve(users["owner"], stock, idempotency_key="reservation-once")
    assert reserve(users["owner"], stock, idempotency_key="reservation-once") == result
    with pytest.raises(IdempotencyMismatch):
        reserve(users["owner"], stock, "6", idempotency_key="reservation-once")
    with pytest.raises(Conflict):
        reserve(users["owner"], stock)
    assert Reservation.objects.count() == 1
    payload = {
        "reservation_id": result["reservation"]["reservation_id"],
        "reason": "No longer needed",
    }
    kwargs = {"expected_state": result["account"]["state"], "idempotency_key": "release-once"}
    release = op(users["owner"], "inventory.release", payload, **kwargs)
    assert op(users["owner"], "inventory.release", payload, **kwargs) == release
    assert ReservationRelease.objects.count() == 1


def test_replay_guard_rechecks_current_permissions(users, stock):
    payload = assertion({"amount": "1", "unit": "ea"}, account_id=stock["account_id"])
    result = op(users["owner"], "inventory.receive", payload, expected_state=stock["state"])
    ctx = Context(user=users["owner"], via="job", request_id="replay")
    parsed = ChangeStock.model_validate(payload)
    authorize_inventory_replay(ctx, parsed, result)
    set_role(users["owner"], "viewer")
    with pytest.raises(PermissionDenied):
        authorize_inventory_replay(ctx, parsed, result)
    remove_member(users["owner"])
    with pytest.raises(NotFound):
        authorize_inventory_replay(ctx, parsed, result)
    assert StockEntry.objects.count() == 2


def test_foreign_workspace_location_is_hidden_and_guarded_by_the_database(
    users, lot, location, other_workspace, workspace
):
    foreign_location = op(
        users["outsider"],
        "inventory.create_location",
        {"workspace_id": other_workspace, "name": "Foreign shelf"},
    )
    # The owner cannot see a location of another workspace at all.
    with pytest.raises(NotFound):
        open_account(users, lot, foreign_location)
    with pytest.raises(DatabaseError), transaction.atomic():
        StockAccount.objects.create(
            lot_id=lot["lot_id"],
            location_id=foreign_location["location_id"],
            dimension="count",
            registered_by=users["owner"],
        )
    assert not StockAccount.objects.exists()


def test_one_lot_is_stocked_at_several_locations_of_the_same_workspace(
    users, workspace, lot, location
):
    second = op(
        users["owner"], "inventory.create_location", {"workspace_id": workspace, "name": "Shelf C"}
    )
    first_account = open_account(users, lot, location)
    second_account = open_account(users, lot, second, amount="4")
    assert first_account["workspace_id"] == second_account["workspace_id"] == workspace
    listed = list_inventory(users["viewer"], workspace)
    assert {a["location_name"] for a in listed["accounts"]} == {"Shelf A", "Shelf C"}
    assert listed["workspace_id"] == workspace and "project_id" in listed


def test_database_protects_history_balance_units_and_reserved_stock(users, stock):
    result = reserve(users["owner"], stock)
    reservation = Reservation.objects.get(id=result["reservation"]["reservation_id"])
    for table in (
        "inventory_stockentry",
        "inventory_reservation",
        "inventory_stockaccount",
        "inventory_location",
    ):
        for sql in (f"UPDATE {table} SET id = id", f"DELETE FROM {table}"):
            if table == "inventory_stockaccount" and sql.startswith("UPDATE"):
                sql = "UPDATE inventory_stockaccount SET dimension = 'length'"
            with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(sql)
    with pytest.raises(DatabaseError), transaction.atomic():
        Reservation.objects.create(
            account_id=stock["account_id"],
            quantity=4,
            amount=4,
            unit="ea",
            purpose="Overbooking",
            actor=users["owner"],
            request_id="raw",
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        Reservation.objects.create(
            account_id=stock["account_id"],
            quantity=1,
            amount=1,
            unit="m",
            purpose="Wrong dimension",
            actor=users["owner"],
            request_id="raw",
        )
    entry = StockEntry.objects.get(account_id=stock["account_id"])
    for after in (Decimal("6"), Decimal("-1"), Decimal("10")):
        with pytest.raises(DatabaseError), transaction.atomic():
            StockEntry.objects.create(
                account=entry.account,
                sequence=2,
                kind="adjustment",
                amount=-4,
                unit="ea",
                before=10,
                after=after,
                reason="Invalid correction",
                assertion_source="Synthetic record",
                assertion_status="declared",
                actor=users["owner"],
                request_id="raw",
            )
    op(
        users["owner"],
        "inventory.release",
        {"reservation_id": str(reservation.id), "reason": "Done"},
        expected_state=result["account"]["state"],
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        ReservationRelease.objects.all().update(reason="Changed")


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("raw", [False, True])
def test_competing_seven_against_ten_one_winner(users, stock, raw):
    barrier = Barrier(2)

    def compete():
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                if raw:
                    with transaction.atomic():
                        Reservation.objects.create(
                            account_id=stock["account_id"],
                            quantity=7,
                            amount=7,
                            unit="ea",
                            purpose="Concurrent synthetic reservation",
                            actor=users["owner"],
                            request_id="raw-thread",
                        )
                else:
                    reserve(users["owner"], stock)
                return "reserved"
            except (Conflict, DatabaseError):
                return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: compete(), range(2)))
    assert sorted(results) == ["conflict", "reserved"]
    assert Reservation.objects.count() == 1
    result = list_inventory(users["owner"], stock["workspace_id"])["accounts"][0]
    assert result["physical_quantity"] == "10" and result["available_quantity"] == "3"


@pytest.mark.parametrize("via", ["api", "job", "mcp"])
def test_retained_reservation_rechecks_a_downgraded_role_across_contexts(users, stock, via):
    from specmate.operations import execute

    payload = {
        "account_id": stock["account_id"],
        "quantity": {"amount": "7", "unit": "ea"},
        "purpose": "Scoped reservation",
    }
    ctx = Context(
        user=users["editor"],
        via=via,
        request_id="replay",
        expected_state=stock["state"],
        idempotency_key="downgraded-reservation",
    )
    first = execute("inventory.reserve", ctx, payload)
    assert execute("inventory.reserve", ctx, payload).replayed
    set_role(users["editor"], "contributor")
    with pytest.raises(PermissionDenied):
        execute("inventory.reserve", ctx, payload)
    if via == "api":
        response = post_op(
            api(users["editor"]),
            "inventory.reserve",
            payload,
            expected_state=stock["state"],
            idempotency_key=ctx.idempotency_key,
        )
        assert response.status_code == 403
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        execute("inventory.reserve", ctx, payload)
    assert Reservation.objects.count() == 1
    assert first.result["account"]["physical_quantity"] == "10"


def test_live_inventory_rejects_cached_read_keys(users, workspace, stock):
    payload = {"workspace_id": workspace}
    with pytest.raises(ValidationFailed):
        op(users["owner"], "inventory.list", payload, idempotency_key="cached-stock")
    assert (
        post_op(
            api(users["owner"]), "inventory.list", payload, idempotency_key="cached-stock"
        ).status_code
        == 422
    )
    reserve(users["owner"], stock)
    assert (
        op(users["viewer"], "inventory.list", payload)["accounts"][0]["available_quantity"] == "3"
    )


def test_api_receipt_replay_and_role_downgrade_use_ledger_operation(users, stock):
    payload = assertion({"amount": "1", "unit": "ea"}, account_id=stock["account_id"])
    kwargs = {"expected_state": stock["state"], "idempotency_key": "api-receipt-once"}
    client = api(users["owner"])
    first = post_op(client, "inventory.receive", payload, **kwargs)
    assert first.status_code == 200 and first.json()["result"]["physical_quantity"] == "11"
    replay = post_op(client, "inventory.receive", payload, **kwargs)
    assert replay.status_code == 200 and replay.json()["replayed"]
    set_role(users["owner"], "viewer")
    assert post_op(client, "inventory.receive", payload, **kwargs).status_code == 403
    assert StockEntry.objects.count() == 2


def test_failed_opening_rolls_back_account_and_key(users, lot, location):
    from specmate.operations.models import IdempotencyRecord

    payload = assertion(
        {"amount": "-1", "unit": "ea"},
        lot_id=lot["lot_id"],
        location_id=location["location_id"],
        dimension="count",
    )
    with pytest.raises(ValidationFailed):
        op(users["owner"], "inventory.open_stock", payload, idempotency_key="invalid-opening")
    assert not StockAccount.objects.exists() and not StockEntry.objects.exists()
    assert not IdempotencyRecord.objects.filter(operation="inventory.open_stock").exists()
    payload["quantity"] = {"amount": "10", "unit": "ea"}
    first = op(users["owner"], "inventory.open_stock", payload, idempotency_key="invalid-opening")
    assert (
        op(users["owner"], "inventory.open_stock", payload, idempotency_key="invalid-opening")
        == first
    )
    assert StockAccount.objects.count() == StockEntry.objects.count() == 1


def test_lot_dimension_stays_fixed_across_locations(users, workspace, lot, location):
    open_account(users, lot, location)
    other = op(
        users["owner"], "inventory.create_location", {"workspace_id": workspace, "name": "Shelf B"}
    )
    with pytest.raises(ValidationFailed):
        open_account(users, lot, other, dimension="length", unit="m")
    with pytest.raises(DatabaseError), transaction.atomic():
        StockAccount.objects.create(
            lot_id=lot["lot_id"],
            location_id=other["location_id"],
            dimension="length",
            registered_by=users["owner"],
        )
    assert StockAccount.objects.count() == 1


def test_inventory_keys_are_namespaced_by_exact_workspace(users, workspace, other_workspace, stock):
    name = "Keyed shelf"
    first = op(
        users["owner"],
        "inventory.create_location",
        {"workspace_id": workspace, "name": name},
        idempotency_key="same-location-key",
    )
    # The foreign workspace administrator reuses the very same key independently.
    outsider = users["outsider"]
    second = op(
        outsider,
        "inventory.create_location",
        {"workspace_id": other_workspace, "name": name},
        idempotency_key="same-location-key",
    )
    assert first["location_id"] != second["location_id"]
    assert (
        op(
            users["owner"],
            "inventory.create_location",
            {"workspace_id": workspace, "name": name},
            idempotency_key="same-location-key",
        )
        == first
    )
    other_definition = op(
        outsider,
        "definition.create",
        {"workspace_id": other_workspace, "kind": "part", "name": "Separate stock"},
    )
    other_revision = freeze(outsider, other_definition["draft_id"], other_definition["state"])
    other_lot = op(
        outsider,
        "catalog.register_lot",
        {"revision_id": other_revision["revision_id"], "label": "Other batch"},
    )
    other_stock = op(
        outsider,
        "inventory.open_stock",
        assertion(
            {"amount": "10", "unit": "ea"},
            lot_id=other_lot["lot_id"],
            location_id=second["location_id"],
            dimension="count",
        ),
    )
    a = mutate(
        users["owner"],
        "receive",
        stock,
        {"amount": "1", "unit": "ea"},
        idempotency_key="same-receipt-key",
    )
    b = mutate(
        outsider,
        "receive",
        other_stock,
        {"amount": "2", "unit": "ea"},
        idempotency_key="same-receipt-key",
    )
    assert a["physical_quantity"] == "11" and b["physical_quantity"] == "12"
    assert (
        mutate(
            users["owner"],
            "receive",
            stock,
            {"amount": "1", "unit": "ea"},
            idempotency_key="same-receipt-key",
        )
        == a
    )
    assert (
        mutate(
            outsider,
            "receive",
            other_stock,
            {"amount": "2", "unit": "ea"},
            idempotency_key="same-receipt-key",
        )
        == b
    )
    with pytest.raises(IdempotencyMismatch):
        mutate(
            users["owner"],
            "receive",
            stock,
            {"amount": "2", "unit": "ea"},
            idempotency_key="same-receipt-key",
        )
    assert StockEntry.objects.count() == 4


def test_inventory_keys_are_separate_for_actor_and_operation(users, stock):
    a = reserve(users["owner"], stock, "1", idempotency_key="shared-key")
    b = reserve(users["editor"], a["account"], "1", idempotency_key="shared-key")
    assert a["reservation"]["reservation_id"] != b["reservation"]["reservation_id"]
    released = op(
        users["owner"],
        "inventory.release",
        {"reservation_id": a["reservation"]["reservation_id"], "reason": "Released"},
        expected_state=b["account"]["state"],
        idempotency_key="shared-key",
    )
    assert released["account"]["physical_quantity"] == "10"
    assert released["account"]["reserved_quantity"] == "1"


def test_current_scope_is_checked_before_key_mismatch_disclosure(users, stock):
    reserve(users["editor"], stock, "1", idempotency_key="scoped-key")
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        reserve(users["editor"], stock, "2", idempotency_key="scoped-key")


def test_reservations_and_work_batches_carry_an_optional_project_context(
    users, workspace, project, stock
):
    plain = reserve(users["owner"], stock, "1")
    assert plain["reservation"]["project_id"] is None
    held = op(
        users["editor"],
        "inventory.reserve",
        {
            "account_id": stock["account_id"],
            "quantity": {"amount": "2", "unit": "ea"},
            "purpose": "Project build",
            "project_id": project,
        },
        expected_state=plain["account"]["state"],
    )
    assert held["reservation"]["project_id"] == project
    # The context is navigation only: the stock stays one workspace ledger.
    assert held["account"]["reserved_quantity"] == "3"
    revision = stock["revision_id"]
    batch = op(
        users["owner"],
        "inventory.create_work_batch",
        {"revision_id": revision, "label": "In project", "project_id": project},
        idempotency_key="project-batch",
    )
    free = op(
        users["owner"],
        "inventory.create_work_batch",
        {"revision_id": revision, "label": "Free batch"},
        idempotency_key="free-batch",
    )
    assert batch["project_id"] == project and free["project_id"] is None
    everything = list_inventory(users["viewer"], workspace)
    assert {b["work_batch_id"] for b in everything["work_batches"]} == {
        batch["work_batch_id"],
        free["work_batch_id"],
    }
    filtered = list_inventory(users["viewer"], workspace, project_id=project)
    assert [b["work_batch_id"] for b in filtered["work_batches"]] == [batch["work_batch_id"]]
    assert filtered["project_id"] == project
    detail = account_detail(users["viewer"], stock["account_id"])
    assert {r["project_id"] for r in detail["reservations"]} == {None, project}


def test_project_context_of_another_workspace_is_not_found(users, stock):
    foreign = op(users["outsider"], "project.create", {"name": "Foreign"})["project_id"]
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "inventory.reserve",
            {
                "account_id": stock["account_id"],
                "quantity": {"amount": "1", "unit": "ea"},
                "purpose": "Foreign context",
                "project_id": foreign,
            },
            expected_state=stock["state"],
        )
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "inventory.create_work_batch",
            {"revision_id": stock["revision_id"], "label": "x", "project_id": foreign},
            idempotency_key="foreign-batch",
        )
    assert not Reservation.objects.exists()
