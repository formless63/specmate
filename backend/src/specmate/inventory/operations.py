from specmate.access.models import Project
from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import PhysicalLot
from specmate.inventory.contracts import (
    CANONICAL_UNITS,
    MAX_QUANTITY,
    ChangeStock,
    Consume,
    CreateLocation,
    CreateWorkBatch,
    ListInventory,
    OpenStock,
    RecordWorkCompletion,
    Release,
    Reserve,
    ReturnUnused,
    quantity_add,
    quantity_subtract,
)
from specmate.inventory.models import (
    Location,
    Reservation,
    ReservationRelease,
    StockAccount,
    StockEntry,
    WorkBatch,
    WorkCompletion,
)
from specmate.inventory.queries import (
    account_result,
    entry_result,
    get_account,
    get_consumption,
    get_location,
    get_lot,
    get_reservation,
    get_work_batch,
    latest_entry,
    list_inventory,
    location_result,
    remaining_quantity,
    reservation_result,
    reserved_quantity,
    returnable_quantity,
    work_batch_result,
)
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.operations.scope import project_scope
from specmate.queries import get_revision


def validate_dimension(quantity, dimension):
    if quantity.dimension != dimension:
        raise ValidationFailed("Quantity dimension does not match this stock account.")


def writable_account(ctx, account_id, permission):
    account = get_account(ctx.user, account_id, lock=True)
    authorize(ctx.user, account.location.project_id, permission)
    if str(account.state) != ctx.require_expected_state():
        raise Conflict("Stock state changed.", details={"current": account_result(account)})
    return account


def append_entry(ctx, account, p, kind, after, **causes):
    prior = latest_entry(account)
    if after is not None and (after < 0 or after > MAX_QUANTITY):
        raise ValidationFailed("Resulting stock balance is outside the supported range.")
    projected_reserved = reserved_quantity(account)
    if kind == "consumption":
        projected_reserved = quantity_subtract(projected_reserved, p.quantity.canonical)
    if after is not None and after < projected_reserved:
        raise Conflict("Stock balance cannot fall below active reservations.")
    entry = StockEntry.objects.create(
        account=account,
        sequence=prior.sequence + 1 if prior else 1,
        kind=kind,
        amount=p.quantity.amount if p.quantity else None,
        unit=p.quantity.unit if p.quantity else CANONICAL_UNITS[account.dimension],
        before=prior.after if prior else None,
        after=after,
        reason=p.reason,
        assertion_source=p.assertion_source,
        assertion_status=p.assertion_status,
        actor=ctx.user,
        request_id=ctx.request_id,
        **causes,
    )
    account.refresh_from_db(fields=["state"])
    return entry_result(entry) if causes else account_result(account)


@operation(
    "inventory.create_location",
    CreateLocation,
    summary="Register a project stock location.",
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def create_location(ctx: Context, p: CreateLocation):
    authorize(ctx.user, p.project_id, Perm.INVENTORY_MANAGE)
    Project.objects.select_for_update().get(id=p.project_id)
    if Location.objects.filter(project_id=p.project_id, name=p.name).exists():
        raise Conflict("This location name is already registered.")
    return location_result(
        Location.objects.create(project_id=p.project_id, name=p.name, registered_by=ctx.user)
    )


@operation(
    "inventory.open_stock",
    OpenStock,
    summary="Establish a lot/location stock account.",
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def open_stock(ctx: Context, p: OpenStock):
    lot = get_lot(ctx.user, p.lot_id)
    location = get_location(ctx.user, p.location_id)
    if lot.revision.definition.project_id != location.project_id:
        raise ValidationFailed("Lot and stock location must belong to the same project.")
    authorize(ctx.user, location.project_id, Perm.INVENTORY_MANAGE)
    PhysicalLot.objects.select_for_update().get(id=lot.id)
    if StockAccount.objects.filter(lot=lot).exclude(dimension=p.dimension).exists():
        raise ValidationFailed(
            "A physical lot must retain the same quantity dimension across locations."
        )
    Location.objects.select_for_update().get(id=location.id)
    if StockAccount.objects.filter(lot=lot, location=location).exists():
        raise Conflict("This lot already has a stock account at this location.")
    if p.quantity:
        validate_dimension(p.quantity, p.dimension)
    account = StockAccount.objects.create(
        lot=lot, location=location, dimension=p.dimension, registered_by=ctx.user
    )
    return append_entry(ctx, account, p, "opening", p.quantity.canonical if p.quantity else None)


def change_stock(ctx, p, kind):
    account = writable_account(ctx, p.account_id, Perm.INVENTORY_MANAGE)
    validate_dimension(p.quantity, account.dimension)
    current = latest_entry(account).after
    if kind == "observation":
        after = p.quantity.canonical
    else:
        if current is None:
            raise Conflict("Stock quantity is unknown; establish an explicit quantity observation.")
        if kind == "receipt" and p.quantity.amount <= 0:
            raise ValidationFailed("Receipt quantity must be positive.")
        if kind == "adjustment" and p.quantity.amount == 0:
            raise ValidationFailed("Adjustment quantity must be nonzero.")
        after = quantity_add(current, p.quantity.canonical)
    return append_entry(ctx, account, p, kind, after)


@operation(
    "inventory.receive",
    ChangeStock,
    summary="Append a stock receipt.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def receive(ctx: Context, p: ChangeStock):
    return change_stock(ctx, p, "receipt")


@operation(
    "inventory.adjust",
    ChangeStock,
    summary="Append a compensating stock adjustment.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def adjust(ctx: Context, p: ChangeStock):
    return change_stock(ctx, p, "adjustment")


@operation(
    "inventory.establish_quantity",
    ChangeStock,
    summary="Record an explicit quantity assertion without claiming physical qualification.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def establish_quantity(ctx: Context, p: ChangeStock):
    return change_stock(ctx, p, "observation")


@operation(
    "inventory.reserve",
    Reserve,
    summary="Reserve availability without consuming physical stock.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def reserve(ctx: Context, p: Reserve):
    account = writable_account(ctx, p.account_id, Perm.INVENTORY_RESERVE)
    validate_dimension(p.quantity, account.dimension)
    if p.quantity.amount <= 0:
        raise ValidationFailed("Reservation quantity must be positive.")
    quantity = latest_entry(account).after
    if quantity is None:
        raise Conflict("Unknown stock quantity cannot satisfy a reservation.")
    if p.quantity.canonical > quantity_subtract(quantity, reserved_quantity(account)):
        raise Conflict(
            "Insufficient available stock.", details={"current": account_result(account)}
        )
    reservation = Reservation.objects.create(
        account=account,
        quantity=p.quantity.canonical,
        amount=p.quantity.amount,
        unit=p.quantity.unit,
        purpose=p.purpose,
        actor=ctx.user,
        request_id=ctx.request_id,
    )
    account.refresh_from_db(fields=["state"])
    return {"reservation": reservation_result(reservation), "account": account_result(account)}


@operation(
    "inventory.release",
    Release,
    summary="Release a reservation without changing physical stock.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def release(ctx: Context, p: Release):
    reservation = get_reservation(ctx.user, p.reservation_id)
    account = writable_account(ctx, reservation.account_id, Perm.INVENTORY_RESERVE)
    if hasattr(reservation, "release"):
        raise Conflict("Reservation has already been released.")
    if remaining_quantity(reservation) == 0:
        raise Conflict("Reservation has no remaining quantity to release.")
    ReservationRelease.objects.create(
        reservation=reservation, reason=p.reason, actor=ctx.user, request_id=ctx.request_id
    )
    account.refresh_from_db(fields=["state"])
    return {"reservation": reservation_result(reservation), "account": account_result(account)}


@operation(
    "inventory.list",
    ListInventory,
    summary="Read current scoped inventory availability.",
    supports_idempotency=False,
)
def inventory_list(ctx: Context, p: ListInventory):
    return list_inventory(ctx.user, p.project_id, offset=p.offset, limit=p.limit)


def inventory_project_scope(ctx: Context, p) -> str:
    """Resolve the exact authorized project for keys, before any retained-result lookup."""
    if isinstance(p, CreateWorkBatch):
        revision = get_revision(ctx.user, p.revision_id)
        project_id = revision.definition.project_id
        authorize(ctx.user, project_id, Perm.INVENTORY_MANAGE)
    elif isinstance(p, RecordWorkCompletion):
        batch = get_work_batch(ctx.user, p.work_batch_id)
        project_id = batch.revision.definition.project_id
        authorize(ctx.user, project_id, Perm.INVENTORY_MANAGE)
    elif isinstance(p, Consume | ReturnUnused):
        if isinstance(p, Consume):
            reservation = get_reservation(ctx.user, p.reservation_id)
            account = get_account(ctx.user, reservation.account_id)
            batch = get_work_batch(ctx.user, p.work_batch_id)
            authorize(ctx.user, account.location.project_id, Perm.INVENTORY_MANAGE)
            if p.physical_unit_id:
                from specmate.physical_units.models import WorkUnitLink
                from specmate.physical_units.queries import get_unit

                unit = get_unit(ctx.user, p.physical_unit_id)
                if (
                    unit.project_id != account.location.project_id
                    or not WorkUnitLink.objects.filter(unit=unit, work_batch=batch).exists()
                ):
                    raise ValidationFailed(
                        "Attributed unit must be linked to the exact work target."
                    )
        else:
            consumption = get_consumption(ctx.user, p.consumption_id)
            account = get_account(ctx.user, consumption.account_id)
            batch = get_work_batch(ctx.user, consumption.work_batch_id)
            if consumption.physical_unit_id:
                from specmate.physical_units.queries import get_unit

                get_unit(ctx.user, consumption.physical_unit_id)
        if batch.revision.definition.project_id != account.location.project_id:
            raise ValidationFailed("Stock and work target must belong to the same project.")
        project_id = account.location.project_id
        authorize(ctx.user, project_id, Perm.INVENTORY_MANAGE)
    elif isinstance(p, CreateLocation):
        authorize(ctx.user, p.project_id, Perm.INVENTORY_MANAGE)
        project_id = p.project_id
    elif isinstance(p, OpenStock):
        lot = get_lot(ctx.user, p.lot_id)
        location = get_location(ctx.user, p.location_id)
        if lot.revision.definition.project_id != location.project_id:
            raise ValidationFailed("Lot and stock location must belong to the same project.")
        authorize(ctx.user, location.project_id, Perm.INVENTORY_MANAGE)
        project_id = location.project_id
    elif isinstance(p, ListInventory):
        authorize(ctx.user, p.project_id, Perm.PROJECT_READ)
        project_id = p.project_id
    else:
        account_id = (
            p.account_id
            if not isinstance(p, Release)
            else get_reservation(ctx.user, p.reservation_id).account_id
        )
        account = get_account(ctx.user, account_id)
        permission = (
            Perm.INVENTORY_RESERVE if isinstance(p, Reserve | Release) else Perm.INVENTORY_MANAGE
        )
        authorize(ctx.user, account.location.project_id, permission)
        project_id = account.location.project_id
    return project_scope(ctx, project_id)


def authorize_inventory_replay(ctx: Context, p, stored_result: dict) -> None:
    """Recheck current scope/authority without appending ledger or reservation records."""
    inventory_project_scope(ctx, p)


def require_stock_key(ctx):
    if not ctx.idempotency_key:
        raise ValidationFailed("Work and usage writes require an idempotency key.")


def writable_work_batch(ctx, work_batch_id, expected_state):
    batch = get_work_batch(ctx.user, work_batch_id, lock=True)
    authorize(ctx.user, batch.revision.definition.project_id, Perm.INVENTORY_MANAGE)
    if str(batch.state) != str(expected_state):
        raise Conflict("Work state changed.", details={"current": work_batch_result(batch)})
    return batch


@operation(
    "inventory.create_work_batch",
    CreateWorkBatch,
    summary="Register planned work against one exact authorized design revision.",
    authorize_replay=lambda ctx, p, stored: authorize_inventory_replay(ctx, p, stored),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def create_work_batch(ctx: Context, p: CreateWorkBatch):
    revision = get_revision(ctx.user, p.revision_id)
    authorize(ctx.user, revision.definition.project_id, Perm.INVENTORY_MANAGE)
    require_stock_key(ctx)
    batch = WorkBatch.objects.create(
        revision=revision,
        kind=p.kind,
        label=p.label,
        planned_units=p.planned_units,
        registered_by=ctx.user,
    )
    return work_batch_result(batch)


@operation(
    "inventory.record_work_completion",
    RecordWorkCompletion,
    summary="Append a reported completion count without inventing actual unit identities.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: authorize_inventory_replay(ctx, p, stored),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def record_work_completion(ctx: Context, p: RecordWorkCompletion):
    batch = writable_work_batch(ctx, p.work_batch_id, ctx.require_expected_state())
    require_stock_key(ctx)
    current = work_batch_result(batch)
    if (
        batch.planned_units is not None
        and current["reported_completed_units"] + p.units_completed > batch.planned_units
    ):
        raise Conflict(
            "Reported completions exceed the planned count.", details={"current": current}
        )
    prior = batch.completions.order_by("-sequence").first()
    record = WorkCompletion.objects.create(
        work_batch=batch,
        sequence=prior.sequence + 1 if prior else 1,
        units_completed=p.units_completed,
        reason=p.reason,
        assertion_source=p.assertion_source,
        assertion_status=p.assertion_status,
        actor=ctx.user,
        request_id=ctx.request_id,
    )
    batch.refresh_from_db(fields=["state"])
    return {"completion_id": str(record.id), "work_batch": work_batch_result(batch)}


@operation(
    "inventory.consume",
    Consume,
    summary="Consume reserved stock for exact work; retain or release the unused reservation.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: authorize_inventory_replay(ctx, p, stored),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def consume(ctx: Context, p: Consume):
    inventory_project_scope(ctx, p)
    reservation = get_reservation(ctx.user, p.reservation_id)
    account = writable_account(ctx, reservation.account_id, Perm.INVENTORY_MANAGE)
    batch = writable_work_batch(ctx, p.work_batch_id, p.expected_work_state)
    require_stock_key(ctx)
    validate_dimension(p.quantity, account.dimension)
    if p.quantity.amount <= 0:
        raise ValidationFailed("Consumption quantity must be positive.")
    remaining = remaining_quantity(reservation)
    if p.quantity.canonical > remaining:
        raise Conflict(
            "Consumption exceeds remaining reserved quantity.",
            details={"reservation": reservation_result(reservation)},
        )
    current = latest_entry(account).after
    if current is None:
        raise Conflict("Unknown stock cannot be consumed.")
    entry = append_entry(
        ctx,
        account,
        p,
        "consumption",
        quantity_subtract(current, p.quantity.canonical),
        reservation=reservation,
        work_batch=batch,
        physical_unit_id=p.physical_unit_id,
    )
    if p.remainder == "release" and remaining_quantity(reservation) > 0:
        ReservationRelease.objects.create(
            reservation=reservation, reason=p.reason, actor=ctx.user, request_id=ctx.request_id
        )
    account.refresh_from_db(fields=["state"])
    batch.refresh_from_db(fields=["state"])
    return {
        "consumption": entry,
        "reservation": reservation_result(reservation),
        "account": account_result(account),
        "work_batch": work_batch_result(batch),
    }


@operation(
    "inventory.return_unused",
    ReturnUnused,
    summary="Return only unused material from one exact consumption; reservations stay closed.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: authorize_inventory_replay(ctx, p, stored),
    idempotency_scope=lambda ctx, p: inventory_project_scope(ctx, p),
)
def return_unused(ctx: Context, p: ReturnUnused):
    inventory_project_scope(ctx, p)
    origin = get_consumption(ctx.user, p.consumption_id)
    account = writable_account(ctx, origin.account_id, Perm.INVENTORY_MANAGE)
    batch = writable_work_batch(ctx, origin.work_batch_id, p.expected_work_state)
    require_stock_key(ctx)
    validate_dimension(p.quantity, account.dimension)
    if p.quantity.amount <= 0:
        raise ValidationFailed("Return quantity must be positive.")
    available = returnable_quantity(origin)
    if p.quantity.canonical > available:
        raise Conflict(
            "Return exceeds the unreturned quantity of this consumption.",
            details={"returnable_quantity": str(available)},
        )
    current = latest_entry(account).after
    entry = append_entry(
        ctx,
        account,
        p,
        "return",
        quantity_add(current, p.quantity.canonical),
        work_batch=batch,
        physical_unit_id=origin.physical_unit_id,
        consumption_origin=origin,
    )
    batch.refresh_from_db(fields=["state"])
    return {
        "return": entry,
        "origin": entry_result(origin),
        "account": account_result(account),
        "work_batch": work_batch_result(batch),
    }
