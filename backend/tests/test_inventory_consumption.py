"""INV-003: independently specified stock effects and bounded planned-work identity."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, localcontext
from threading import Barrier

import pytest
from django.db import DatabaseError, close_old_connections, connection, transaction

from specmate.inventory.contracts import Quantity
from specmate.inventory.models import StockAccount, StockEntry, WorkBatch, WorkCompletion
from specmate.inventory.queries import account_detail, latest_entry, work_batch_detail
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op, remove_member, set_grants, set_role
from .test_design import freeze
from .test_inventory import assertion, open_account, reserve
from .test_transports import api, post_op


@pytest.fixture
def location(users, workspace):
    return op(
        users["owner"], "inventory.create_location", {"workspace_id": workspace, "name": "Shelf A"}
    )


@pytest.fixture
def lot(users, definition):
    revision = freeze(users["owner"], definition["draft_id"], definition["state"])
    return op(
        users["editor"],
        "catalog.register_lot",
        {"revision_id": revision["revision_id"], "label": "Synthetic batch"},
    )


@pytest.fixture
def stock(users, lot, location):
    return open_account(users, lot, location)


def create_work(user, revision_id, *, planned=10, label="Synthetic work", key="work-one"):
    return op(
        user,
        "inventory.create_work_batch",
        {"revision_id": revision_id, "kind": "batch", "label": label, "planned_units": planned},
        idempotency_key=key,
    )


@pytest.fixture
def work(users, lot):
    return create_work(users["owner"], lot["revision_id"])


def use(user, reservation, work, amount="4", *, unit="ea", remainder="retain", key="consume-one"):
    return op(
        user,
        "inventory.consume",
        assertion(
            {"amount": amount, "unit": unit},
            reservation_id=reservation["reservation"]["reservation_id"],
            work_batch_id=work["work_batch_id"],
            expected_work_state=work["state"],
            remainder=remainder,
        ),
        expected_state=reservation["account"]["state"],
        idempotency_key=key,
    )


def give_back(user, used, amount="1", *, unit="ea", key="return-one"):
    return op(
        user,
        "inventory.return_unused",
        assertion(
            {"amount": amount, "unit": unit},
            consumption_id=used["consumption"]["entry_id"],
            expected_work_state=used["work_batch"]["state"],
        ),
        expected_state=used["account"]["state"],
        idempotency_key=key,
    )


def complete(user, work, units=2, *, key="complete-one"):
    return op(
        user,
        "inventory.record_work_completion",
        {
            "work_batch_id": work["work_batch_id"],
            "units_completed": units,
            "reason": "Partial work report",
            "assertion_source": "Synthetic work log",
            "assertion_status": "declared",
        },
        expected_state=work["state"],
        idempotency_key=key,
    )


def test_independent_inventory_fixture_partial_consume_release_return_once(users, stock, work):
    reserved = reserve(users["owner"], stock)
    used = use(users["owner"], reserved, work)
    assert used["account"]["physical_quantity"] == "6"
    assert used["account"]["reserved_quantity"] == "3"
    assert used["account"]["available_quantity"] == "3"
    assert used["reservation"]["quantity"] == "7"
    assert used["reservation"]["consumed_quantity"] == "4"
    assert used["reservation"]["remaining_quantity"] == "3"
    assert use(users["owner"], reserved, work) == used
    released = op(
        users["owner"],
        "inventory.release",
        {
            "reservation_id": reserved["reservation"]["reservation_id"],
            "reason": "Release unused allocation",
        },
        expected_state=used["account"]["state"],
        idempotency_key="release-remain",
    )
    assert released["account"]["available_quantity"] == "6"
    used["account"] = released["account"]
    returned = give_back(users["owner"], used)
    assert (
        returned["account"]["physical_quantity"] == returned["account"]["available_quantity"] == "7"
    )
    assert returned["account"]["reserved_quantity"] == "0"
    assert returned["origin"]["returnable_quantity"] == "3"
    assert give_back(users["owner"], used) == returned
    detail = account_detail(users["viewer"], stock["account_id"])
    assert detail["reservations"][0]["status"] == "released"
    assert detail["entries"][0]["consumption_origin_id"] == used["consumption"]["entry_id"]
    assert detail["entries"][1]["work_batch_id"] == work["work_batch_id"]
    assert StockEntry.objects.count() == 3


def test_consumption_explicit_release_closes_only_unused_part_and_return_cannot_reopen(
    users, stock, work
):
    used = use(users["owner"], reserve(users["owner"], stock), work, remainder="release")
    assert used["account"]["physical_quantity"] == used["account"]["available_quantity"] == "6"
    assert used["reservation"]["status"] == "released"
    returned = give_back(users["owner"], used, "4")
    assert returned["account"]["available_quantity"] == "10"
    assert returned["account"]["reserved_quantity"] == "0"
    with pytest.raises(Conflict):
        use(
            users["owner"],
            {"reservation": used["reservation"], "account": returned["account"]},
            returned["work_batch"],
            "1",
            key="closed",
        )


def test_full_consumption_stays_closed_after_a_return(users, stock, work):
    used = use(users["owner"], reserve(users["owner"], stock), work, "7")
    assert (
        used["reservation"]["status"] == "consumed" and used["account"]["available_quantity"] == "3"
    )
    returned = give_back(users["owner"], used, "1")
    assert returned["account"]["available_quantity"] == "4"
    assert (
        account_detail(users["owner"], stock["account_id"])["reservations"][0]["status"]
        == "consumed"
    )


def test_original_units_and_consumption_caps_apply_to_length(users, lot, location, work):
    stock = open_account(users, lot, location, dimension="length", amount="10", unit="m")
    reserved = reserve(users["owner"], stock, "700", "cm")
    used = use(users["owner"], reserved, work, "4000", unit="mm")
    assert used["consumption"]["amount"] == "4000" and used["consumption"]["unit"] == "mm"
    assert (
        used["account"]["physical_quantity"] == "6" and used["account"]["reserved_quantity"] == "3"
    )
    returned = give_back(users["owner"], used, "50", unit="cm")
    assert (
        returned["account"]["physical_quantity"] == "6.5"
        and returned["account"]["available_quantity"] == "3.5"
    )
    assert returned["origin"]["returnable_quantity"] == "3.5"
    used.update(account=returned["account"], work_batch=returned["work_batch"])
    with pytest.raises(Conflict):
        give_back(users["owner"], used, "4", unit="m", key="excess-return")
    with pytest.raises(ValidationFailed):
        give_back(users["owner"], used, "1", unit="ea", key="wrong-unit")


def test_progress_reports_partial_counts_and_unknown_plan_is_not_zero(users, work, lot):
    from specmate.physical_units.models import PhysicalUnit

    first = complete(users["owner"], work, 2)
    assert first["work_batch"]["reported_completed_units"] == 2
    assert first["work_batch"]["progress"] == "partial"
    assert complete(users["owner"], work, 2) == first
    with pytest.raises(Conflict):
        complete(users["owner"], first["work_batch"], 9, key="over-plan")
    unknown = create_work(users["owner"], lot["revision_id"], planned=None, key="unknown-work")
    reported = complete(users["owner"], unknown, 3, key="unknown-complete")
    assert reported["work_batch"]["planned_units"] is None
    assert reported["work_batch"]["progress"] == "partial"
    assert reported["work_batch"]["actual_unit_tracking"] == "separate_records"
    assert PhysicalUnit.objects.count() == 0
    assert reported["work_batch"]["physical_qualification"] is False
    detail = work_batch_detail(users["viewer"], work["work_batch_id"])
    assert len(detail["completions"]) == 1 and detail["completions"][0]["units_completed"] == 2
    assert (
        api(users["viewer"]).get(f"/api/v0/inventory/work-batches/{work['work_batch_id']}").json()
        == detail
    )


def test_usage_does_not_imply_completion_and_target_revision_stays_distinct(
    users, project, stock, workspace
):
    target = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace, "kind": "assembly", "name": "Build target"},
    )
    revision = freeze(users["owner"], target["draft_id"], target["state"])
    work = create_work(users["owner"], revision["revision_id"])
    used = use(users["owner"], reserve(users["owner"], stock), work)
    assert used["work_batch"]["revision_id"] != stock["revision_id"]
    assert used["work_batch"]["reported_completed_units"] == 0
    assert (
        work_batch_detail(users["owner"], work["work_batch_id"])["usage"][0]["entry_id"]
        == used["consumption"]["entry_id"]
    )


def test_scope_current_grants_and_replay_are_authoritative(users, project, stock, work):
    reserved = reserve(users["owner"], stock)
    for who, error in [
        ("editor", PermissionDenied),
        ("contributor", PermissionDenied),
        ("viewer", PermissionDenied),
        ("outsider", NotFound),
    ]:
        with pytest.raises(error):
            use(users[who], reserved, work)
    set_grants(users["editor"], ["inventory.manage"])
    used = use(users["editor"], reserved, work)
    assert use(users["editor"], reserved, work) == used
    set_grants(users["editor"], [])
    with pytest.raises(PermissionDenied):
        use(users["editor"], reserved, work)
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        use(users["editor"], reserved, work)
    assert StockEntry.objects.count() == 2


def test_invalid_state_quantity_and_key_leave_all_rows_unchanged(users, stock, work):
    reserved = reserve(users["owner"], stock)
    for quantity in ("8", "0", "-1"):
        with pytest.raises((Conflict, ValidationFailed)):
            use(users["owner"], reserved, work, quantity, key="invalid-" + quantity)
    with pytest.raises(ValidationFailed):
        use(users["owner"], reserved, work, key=None)
    with pytest.raises(Conflict):
        use(users["owner"], reserved, {**work, "state": str(uuid.uuid4())}, key="stale-work")
    used = use(users["owner"], reserved, work)
    with pytest.raises(IdempotencyMismatch):
        use(users["owner"], reserved, work, "3")
    with pytest.raises(Conflict):
        give_back(users["owner"], used, "5")
    assert StockEntry.objects.count() == 2
    assert WorkCompletion.objects.count() == 0


def test_transaction_rollback_after_append_does_not_spend_reservation_or_work_state(
    users, stock, work
):
    reserved = reserve(users["owner"], stock)
    with pytest.raises(RuntimeError), transaction.atomic():
        use(users["owner"], reserved, work)
        raise RuntimeError("Synthetic rollback checkpoint")
    assert StockEntry.objects.count() == 1
    assert (
        str(StockAccount.objects.get(id=stock["account_id"]).state) == reserved["account"]["state"]
    )
    assert str(WorkBatch.objects.get(id=work["work_batch_id"]).state) == work["state"]
    assert use(users["owner"], reserved, work)["account"]["physical_quantity"] == "6"


def test_work_and_completion_database_history_is_immutable(users, work):
    complete(users["owner"], work)
    with pytest.raises(DatabaseError), transaction.atomic():
        WorkBatch.objects.filter(id=work["work_batch_id"]).update(label="Rewritten")
    with pytest.raises(DatabaseError), transaction.atomic():
        WorkCompletion.objects.all().update(units_completed=9)
    with pytest.raises(DatabaseError), transaction.atomic():
        WorkCompletion.objects.all().delete()


def test_foreign_workspace_work_target_is_hidden_and_rejected_by_the_database(
    users, stock, work, other_workspace
):
    definition = op(
        users["outsider"],
        "definition.create",
        {"workspace_id": other_workspace, "kind": "part", "name": "Other target"},
    )
    revision = freeze(users["outsider"], definition["draft_id"], definition["state"])
    other_work = create_work(users["outsider"], revision["revision_id"], key="other-work")
    reserved = reserve(users["owner"], stock)
    with pytest.raises(NotFound):
        use(users["owner"], reserved, other_work)
    with pytest.raises(DatabaseError), transaction.atomic():
        StockEntry.objects.create(
            account_id=stock["account_id"],
            sequence=2,
            kind="consumption",
            amount=4,
            unit="ea",
            before=10,
            after=6,
            reservation_id=reserved["reservation"]["reservation_id"],
            work_batch_id=other_work["work_batch_id"],
            reason="Wrong scope",
            assertion_source="Synthetic",
            assertion_status="declared",
            actor=users["owner"],
            request_id="raw",
        )
    assert StockEntry.objects.count() == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("kind", ["consume", "return"])
@pytest.mark.parametrize("raw", [False, True])
def test_concurrent_overconsumption_and_overreturn_have_one_winner(users, stock, work, kind, raw):
    reserved = reserve(users["owner"], stock)
    used = use(users["owner"], reserved, work) if kind == "return" else None
    barrier = Barrier(2)

    def compete(index):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                if raw:
                    with transaction.atomic():
                        account = StockAccount.objects.select_for_update().get(
                            id=stock["account_id"]
                        )
                        prior = latest_entry(account)
                        extra = (
                            {"reservation_id": reserved["reservation"]["reservation_id"]}
                            if kind == "consume"
                            else {"consumption_origin_id": used["consumption"]["entry_id"]}
                        )
                        amount = Decimal(4 if kind == "consume" else 3)
                        StockEntry.objects.create(
                            account=account,
                            sequence=prior.sequence + 1,
                            kind="consumption" if kind == "consume" else "return",
                            amount=amount,
                            unit="ea",
                            before=prior.after,
                            after=prior.after - amount
                            if kind == "consume"
                            else prior.after + amount,
                            work_batch_id=work["work_batch_id"],
                            reason="Concurrent operation",
                            assertion_source="Synthetic log",
                            assertion_status="declared",
                            actor=users["owner"],
                            request_id="raw-thread",
                            **extra,
                        )
                elif kind == "consume":
                    use(users["owner"], reserved, work, key=f"competing-{index}")
                else:
                    give_back(users["owner"], used, "3", key=f"competing-{index}")
                return "accepted"
            except (Conflict, DatabaseError):
                return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(compete, range(2)))
    assert sorted(results) == ["accepted", "conflict"]
    result = account_detail(users["owner"], stock["account_id"])["account"]
    assert result["physical_quantity"] == ("6" if kind == "consume" else "9")
    assert result["reserved_quantity"] == "3"


@pytest.mark.parametrize(
    "amount",
    [
        "1e-9999999",
        "1e9999999",
        "0e-9999999",
        "1.0000000001",
        "NaN",
        "Infinity",
        True,
        False,
        0.0,
        1.5,
    ],
)
def test_adversarial_quantities_rejected_before_stock_changes(users, stock, amount):
    payload = assertion({"amount": amount, "unit": "m"}, account_id=stock["account_id"])
    assert (
        post_op(
            api(users["owner"]), "inventory.receive", payload, expected_state=stock["state"]
        ).status_code
        == 422
    )
    assert StockEntry.objects.count() == 1


def test_raw_json_underflow_and_decimal_context_do_not_silently_round(users, stock):
    body = json.dumps(
        {
            "operation": "inventory.receive",
            "request_id": "raw-tiny",
            "expected_state": stock["state"],
            "payload": assertion(
                {"amount": "raw-number", "unit": "m"}, account_id=stock["account_id"]
            ),
        }
    )
    body = body.replace('"raw-number"', "1e-9999999")
    response = api(users["owner"]).post("/api/v0/operations", body, content_type="application/json")
    assert response.status_code == 422 and StockEntry.objects.count() == 1
    with localcontext() as context:
        context.prec = 2
        quantity = Quantity.model_validate({"amount": "123456789.123456789", "unit": "m"})
        assert quantity.canonical == Decimal("123456789.123456789")
        assert Quantity.model_validate(
            {"amount": Decimal("0.001"), "unit": "m"}
        ).canonical == Decimal("0.001")
        assert Quantity.model_validate({"amount": 0, "unit": "ea"}).canonical == Decimal(0)
    schema = Quantity.model_json_schema()["properties"]["amount"]
    assert {choice.get("type") for choice in schema["anyOf"]} == {"string", "integer"}


def test_membership_removal_is_checked_before_reads_replay_and_conflict(
    users, project, stock, workspace
):
    from .test_assemblies import create, occ, part

    _, child = part(users["owner"], project)
    target = create(users["owner"], project, [occ("child", child)])
    revision = freeze(users["owner"], target["draft_id"], target["state"])
    work = create_work(users["owner"], revision["revision_id"])
    reserved = reserve(users["owner"], stock)
    used = use(users["owner"], reserved, work)
    returned = give_back(users["owner"], used)
    completion = complete(users["owner"], returned["work_batch"])
    remove_member(users["owner"])
    for command in [
        lambda: create_work(users["owner"], revision["revision_id"]),
        lambda: use(users["owner"], reserved, work),
        lambda: give_back(users["owner"], used),
        lambda: complete(users["owner"], returned["work_batch"]),
        lambda: complete(users["owner"], completion["work_batch"], key="stale-denied"),
    ]:
        with pytest.raises(NotFound):
            command()
    client = api(users["owner"])
    for url in [
        f"inventory/work-batches/{work['work_batch_id']}",
        f"inventory/accounts/{stock['account_id']}",
        f"inventory/workspaces/{workspace}",
    ]:
        assert client.get(f"/api/v0/{url}").status_code == 404
    assert StockEntry.objects.count() == 3 and WorkCompletion.objects.count() == 1


def test_http_consumption_return_completion_and_revoked_replay(users, project, stock, work):
    reserved = reserve(users["owner"], stock)
    client = api(users["owner"])
    payload = assertion(
        {"amount": "4", "unit": "ea"},
        reservation_id=reserved["reservation"]["reservation_id"],
        work_batch_id=work["work_batch_id"],
        expected_work_state=work["state"],
        remainder="retain",
    )
    kwargs = {"expected_state": reserved["account"]["state"], "idempotency_key": "http-use"}
    first = post_op(client, "inventory.consume", payload, **kwargs)
    assert first.status_code == 200
    used = first.json()["result"]
    assert post_op(client, "inventory.consume", payload, **kwargs).json()["replayed"]
    back_payload = assertion(
        {"amount": "1", "unit": "ea"},
        consumption_id=used["consumption"]["entry_id"],
        expected_work_state=used["work_batch"]["state"],
    )
    back_kwargs = {"expected_state": used["account"]["state"], "idempotency_key": "http-back"}
    returned = post_op(client, "inventory.return_unused", back_payload, **back_kwargs)
    assert returned.status_code == 200
    assert returned.json()["result"]["account"]["available_quantity"] == "4"
    completion_payload = {
        "work_batch_id": work["work_batch_id"],
        "units_completed": 2,
        "reason": "Work report",
        "assertion_source": "Synthetic job log",
    }
    completion_kwargs = {
        "expected_state": returned.json()["result"]["work_batch"]["state"],
        "idempotency_key": "http-complete",
    }
    reported = post_op(
        client, "inventory.record_work_completion", completion_payload, **completion_kwargs
    )
    assert reported.status_code == 200
    assert reported.json()["result"]["work_batch"]["reported_completed_units"] == 2
    set_role(users["owner"], "viewer")
    for name, data, envelope in [
        ("consume", payload, kwargs),
        ("return_unused", back_payload, back_kwargs),
        ("record_work_completion", completion_payload, completion_kwargs),
    ]:
        assert post_op(client, "inventory." + name, data, **envelope).status_code == 403
    assert StockEntry.objects.count() == 3 and WorkCompletion.objects.count() == 1


def test_membership_removal_blocks_stock_reads_new_writes_and_replay(
    users, project, location, workspace
):
    from .test_assemblies import create, occ, part

    _, child = part(users["owner"], project)
    target = create(users["owner"], project, [occ("child", child)])
    revision = freeze(users["owner"], target["draft_id"], target["state"])
    lot = op(
        users["owner"],
        "catalog.register_lot",
        {
            "revision_id": revision["revision_id"],
            "label": "Composite stock",
        },
    )
    stock = open_account(users, lot, location)
    reserved = reserve(users["owner"], stock)
    remove_member(users["owner"])
    for command in [
        lambda: open_account(users, lot, location),
        lambda: reserve(users["owner"], stock),
        lambda: op(
            users["owner"],
            "inventory.release",
            {
                "reservation_id": reserved["reservation"]["reservation_id"],
                "reason": "Release",
            },
            expected_state=reserved["account"]["state"],
        ),
    ]:
        with pytest.raises(NotFound):
            command()
    for url in [f"inventory/accounts/{stock['account_id']}", f"inventory/workspaces/{workspace}"]:
        assert api(users["owner"]).get(f"/api/v0/{url}").status_code == 404
    assert StockEntry.objects.count() == 1


def test_mcp_context_work_commands_share_idempotency_and_current_authority(users, project, stock):
    from specmate.operations import Context, execute

    set_grants(users["editor"], ["inventory.manage"])
    calls = []

    def invoke(name, payload, state=None):
        ctx = Context(
            user=users["editor"],
            via="mcp",
            request_id=name,
            expected_state=state,
            idempotency_key=name,
        )
        result = execute(name, ctx, payload)
        calls.append((name, ctx, payload, result.result))
        return result.result

    work = invoke(
        "inventory.create_work_batch",
        {
            "revision_id": stock["revision_id"],
            "label": "Agent reported work",
            "planned_units": 3,
        },
    )
    reservation = reserve(users["owner"], stock)
    used = invoke(
        "inventory.consume",
        assertion(
            {"amount": "2", "unit": "ea"},
            reservation_id=reservation["reservation"]["reservation_id"],
            work_batch_id=work["work_batch_id"],
            expected_work_state=work["state"],
            remainder="retain",
        ),
        reservation["account"]["state"],
    )
    returned = invoke(
        "inventory.return_unused",
        assertion(
            {"amount": "1", "unit": "ea"},
            consumption_id=used["consumption"]["entry_id"],
            expected_work_state=used["work_batch"]["state"],
        ),
        used["account"]["state"],
    )
    invoke(
        "inventory.record_work_completion",
        {
            "work_batch_id": work["work_batch_id"],
            "units_completed": 1,
            "reason": "Partial count",
            "assertion_source": "Synthetic agent report",
        },
        returned["work_batch"]["state"],
    )
    for name, ctx, payload, original in calls:
        replay = execute(name, ctx, payload)
        assert replay.replayed and replay.result == original
    set_grants(users["editor"], [])
    for name, ctx, payload, _ in calls:
        with pytest.raises(PermissionDenied):
            execute(name, ctx, payload)
    assert StockEntry.objects.count() == 3 and WorkCompletion.objects.count() == 1


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("raw", [True, False])
def test_concurrent_partial_completions_cannot_double_count_planned_capacity(users, work, raw):
    barrier = Barrier(2)

    def compete(index):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                if raw:
                    with transaction.atomic():
                        batch = WorkBatch.objects.select_for_update().get(id=work["work_batch_id"])
                        WorkCompletion.objects.create(
                            work_batch=batch,
                            sequence=batch.completions.count() + 1,
                            units_completed=6,
                            reason="Concurrent partial completion",
                            assertion_source="Synthetic log",
                            assertion_status="declared",
                            actor=users["owner"],
                            request_id="raw",
                        )
                else:
                    complete(users["owner"], work, 6, key=f"competing-completion-{index}")
                return "accepted"
            except (Conflict, DatabaseError):
                return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(compete, range(2)))
    assert sorted(result) == ["accepted", "conflict"]
    assert (
        work_batch_detail(users["owner"], work["work_batch_id"])["work_batch"][
            "reported_completed_units"
        ]
        == 6
    )
