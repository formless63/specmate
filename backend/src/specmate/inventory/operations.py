from specmate.access.models import Project
from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import PhysicalLot
from specmate.inventory.contracts import (
    CANONICAL_UNITS,
    MAX_QUANTITY,
    ChangeStock,
    CreateLocation,
    ListInventory,
    OpenStock,
    Release,
    Reserve,
)
from specmate.inventory.models import (
    Location,
    Reservation,
    ReservationRelease,
    StockAccount,
    StockEntry,
)
from specmate.inventory.queries import (
    account_result,
    get_account,
    get_location,
    get_lot,
    get_reservation,
    latest_entry,
    list_inventory,
    location_result,
    reservation_result,
    reserved_quantity,
)
from specmate.operations import Conflict, Context, ValidationFailed, operation


def validate_dimension(quantity, dimension):
    if quantity.dimension != dimension:
        raise ValidationFailed("Quantity dimension does not match this stock account.")


def writable_account(ctx, account_id, permission):
    account = get_account(ctx.user, account_id, lock=True)
    authorize(ctx.user, account.location.project_id, permission)
    if str(account.state) != ctx.require_expected_state():
        raise Conflict("Stock state changed.", details={"current": account_result(account)})
    return account


def append_entry(ctx, account, p, kind, after):
    prior = latest_entry(account)
    if after is not None and (after < 0 or after > MAX_QUANTITY):
        raise ValidationFailed("Resulting stock balance is outside the supported range.")
    if after is not None and after < reserved_quantity(account):
        raise Conflict("Stock balance cannot fall below active reservations.")
    StockEntry.objects.create(
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
    )
    account.refresh_from_db(fields=["state"])
    return account_result(account)


@operation(
    "inventory.create_location",
    CreateLocation,
    summary="Register a project stock location.",
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
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
        after = current + p.quantity.canonical
    return append_entry(ctx, account, p, kind, after)


@operation(
    "inventory.receive",
    ChangeStock,
    summary="Append a stock receipt.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
)
def receive(ctx: Context, p: ChangeStock):
    return change_stock(ctx, p, "receipt")


@operation(
    "inventory.adjust",
    ChangeStock,
    summary="Append a compensating stock adjustment.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
)
def adjust(ctx: Context, p: ChangeStock):
    return change_stock(ctx, p, "adjustment")


@operation(
    "inventory.establish_quantity",
    ChangeStock,
    summary="Record an explicit quantity assertion without claiming physical qualification.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
)
def establish_quantity(ctx: Context, p: ChangeStock):
    return change_stock(ctx, p, "observation")


@operation(
    "inventory.reserve",
    Reserve,
    summary="Reserve availability without consuming physical stock.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, result: authorize_inventory_replay(ctx, p, result),
)
def reserve(ctx: Context, p: Reserve):
    account = writable_account(ctx, p.account_id, Perm.INVENTORY_RESERVE)
    validate_dimension(p.quantity, account.dimension)
    if p.quantity.amount <= 0:
        raise ValidationFailed("Reservation quantity must be positive.")
    quantity = latest_entry(account).after
    if quantity is None:
        raise Conflict("Unknown stock quantity cannot satisfy a reservation.")
    if p.quantity.canonical > quantity - reserved_quantity(account):
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
)
def release(ctx: Context, p: Release):
    reservation = get_reservation(ctx.user, p.reservation_id)
    account = writable_account(ctx, reservation.account_id, Perm.INVENTORY_RESERVE)
    if hasattr(reservation, "release"):
        raise Conflict("Reservation has already been released.")
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


def authorize_inventory_replay(ctx: Context, p, stored_result: dict) -> None:
    """Recheck current scope/authority without appending ledger or reservation records."""
    if isinstance(p, CreateLocation):
        authorize(ctx.user, p.project_id, Perm.INVENTORY_MANAGE)
    elif isinstance(p, OpenStock):
        lot = get_lot(ctx.user, p.lot_id)
        location = get_location(ctx.user, p.location_id)
        if lot.revision.definition.project_id != location.project_id:
            raise ValidationFailed("Lot and stock location must belong to the same project.")
        authorize(ctx.user, location.project_id, Perm.INVENTORY_MANAGE)
    elif isinstance(p, ListInventory):
        authorize(ctx.user, p.project_id, Perm.PROJECT_READ)
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
