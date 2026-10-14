from decimal import Decimal

from django.db import transaction
from django.db.models import F, Sum

from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import PhysicalLot
from specmate.inventory.contracts import (
    CANONICAL_UNITS,
    AccountResult,
    ReservationResult,
    WorkBatchResult,
    quantity_subtract,
)
from specmate.inventory.models import Location, Reservation, StockAccount, StockEntry, WorkBatch
from specmate.operations import NotFound
from specmate.queries import get_revision


def decimal_text(value):
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def get_lot(user, lot_id):
    lot = PhysicalLot.objects.select_related("revision__definition").filter(id=lot_id).first()
    if lot is None:
        raise NotFound("Lot not found.")
    get_revision(user, lot.revision_id)
    return lot


def context_project(workspace_id, project_id):
    """The optional project context; a project outside the workspace is simply not found."""
    from specmate.access.models import Project

    project = Project.objects.filter(id=project_id, workspace_id=workspace_id).first()
    if project is None:
        raise NotFound("Project not found.")
    return project


def get_location(user, location_id):
    location = Location.objects.filter(id=location_id).first()
    if location is None:
        raise NotFound("Location not found.")
    authorize(user, location.workspace_id, Perm.WORKSPACE_READ)
    return location


def get_account(user, account_id, *, lock=False):
    query = StockAccount.objects.select_related("lot__revision__definition", "location")
    if lock:
        query = query.select_for_update(of=("self",))
    account = query.filter(id=account_id).first()
    if account is None:
        raise NotFound("Stock account not found.")
    authorize(user, account.location.workspace_id, Perm.WORKSPACE_READ)
    get_revision(user, account.lot.revision_id)
    authorize_current_assertion(user, account)
    return account


def latest_entry(account):
    return account.entries.order_by("-sequence").first()


def authorize_current_assertion(user, account):
    current = latest_entry(account)
    if current and current.work_batch_id:
        get_work_batch(user, current.work_batch_id)


def reserved_quantity(account):
    # Canonical consumption is before - after, so original units never cause rounding.
    reservations = account.reservations.filter(release__isnull=True)
    original = reservations.aggregate(total=Sum("quantity"))["total"] or Decimal(0)
    consumed = StockEntry.objects.filter(
        reservation__in=reservations, kind="consumption"
    ).aggregate(total=Sum(F("before") - F("after")))["total"] or Decimal(0)
    return quantity_subtract(original, consumed)


def consumed_quantity(reservation):
    return StockEntry.objects.filter(reservation=reservation, kind="consumption").aggregate(
        total=Sum(F("before") - F("after"))
    )["total"] or Decimal(0)


def remaining_quantity(reservation):
    return (
        Decimal(0)
        if hasattr(reservation, "release")
        else quantity_subtract(reservation.quantity, consumed_quantity(reservation))
    )


def returnable_quantity(consumption):
    returned = consumption.returns.aggregate(total=Sum(F("after") - F("before")))[
        "total"
    ] or Decimal(0)
    return quantity_subtract(quantity_subtract(consumption.before, consumption.after), returned)


def account_result(account):
    entry = latest_entry(account)
    quantity = entry.after if entry else None
    reserved = reserved_quantity(account)
    return AccountResult(
        account_id=account.id,
        workspace_id=account.location.workspace_id,
        lot_id=account.lot_id,
        lot_label=account.lot.label,
        revision_id=account.lot.revision_id,
        definition_id=account.lot.revision.definition_id,
        location_id=account.location_id,
        location_name=account.location.name,
        dimension=account.dimension,
        unit=CANONICAL_UNITS[account.dimension],
        quantity_status="known" if quantity is not None else "unknown",
        physical_quantity=decimal_text(quantity) if quantity is not None else None,
        reserved_quantity=decimal_text(reserved),
        available_quantity=decimal_text(quantity_subtract(quantity, reserved))
        if quantity is not None
        else None,
        state=str(account.state),
        assertion_source=entry.assertion_source if entry else "Not established",
        assertion_status=entry.assertion_status if entry else "declared",
    ).model_dump(mode="json")


def reservation_result(reservation):
    consumed = consumed_quantity(reservation)
    remaining = remaining_quantity(reservation)
    return ReservationResult(
        reservation_id=reservation.id,
        account_id=reservation.account_id,
        quantity=decimal_text(reservation.quantity),
        amount=decimal_text(reservation.amount),
        unit=reservation.unit,
        purpose=reservation.purpose,
        project_id=reservation.project_id,
        consumed_quantity=decimal_text(consumed),
        remaining_quantity=decimal_text(remaining),
        status="released"
        if hasattr(reservation, "release")
        else "consumed"
        if remaining == 0
        else "active",
        actor_id=reservation.actor_id,
        request_id=reservation.request_id,
        created_at=reservation.created_at.isoformat(),
    ).model_dump(mode="json")


def get_reservation(user, reservation_id):
    reservation = Reservation.objects.filter(id=reservation_id).first()
    if reservation is None:
        raise NotFound("Reservation not found.")
    get_account(user, reservation.account_id)
    return reservation


def get_work_batch(user, work_batch_id, *, lock=False):
    query = WorkBatch.objects.select_related("revision__definition")
    if lock:
        query = query.select_for_update(of=("self",))
    batch = query.filter(id=work_batch_id).first()
    if batch is None:
        raise NotFound("Work batch not found.")
    get_revision(user, batch.revision_id)
    return batch


def work_batch_result(batch):
    completed = batch.completions.aggregate(total=Sum("units_completed"))["total"] or 0
    return WorkBatchResult(
        work_batch_id=batch.id,
        workspace_id=batch.revision.definition.workspace_id,
        revision_id=batch.revision_id,
        definition_id=batch.revision.definition_id,
        kind=batch.kind,
        label=batch.label,
        planned_units=batch.planned_units,
        project_id=batch.project_id,
        reported_completed_units=completed,
        progress="none_reported"
        if not completed
        else "reported_complete"
        if completed == batch.planned_units
        else "partial",
        state=str(batch.state),
    ).model_dump(mode="json")


def get_consumption(user, consumption_id):
    entry = StockEntry.objects.filter(id=consumption_id, kind="consumption").first()
    if entry is None:
        raise NotFound("Consumption not found.")
    get_account(user, entry.account_id)
    get_work_batch(user, entry.work_batch_id)
    return entry


def entry_result(entry):
    return {
        "entry_id": str(entry.id),
        "sequence": entry.sequence,
        "kind": entry.kind,
        "account_id": str(entry.account_id),
        "amount": decimal_text(entry.amount) if entry.amount is not None else None,
        "unit": entry.unit,
        "before": decimal_text(entry.before) if entry.before is not None else None,
        "after": decimal_text(entry.after) if entry.after is not None else None,
        "reason": entry.reason,
        "assertion_source": entry.assertion_source,
        "assertion_status": entry.assertion_status,
        "actor_id": entry.actor_id,
        "request_id": entry.request_id,
        "created_at": entry.created_at.isoformat(),
        "reservation_id": str(entry.reservation_id) if entry.reservation_id else None,
        "work_batch_id": str(entry.work_batch_id) if entry.work_batch_id else None,
        "physical_unit_id": str(entry.physical_unit_id) if entry.physical_unit_id else None,
        "consumption_origin_id": str(entry.consumption_origin_id)
        if entry.consumption_origin_id
        else None,
        "returnable_quantity": decimal_text(returnable_quantity(entry))
        if entry.kind == "consumption"
        else None,
    }


def location_result(location):
    return {
        "location_id": str(location.id),
        "workspace_id": str(location.workspace_id),
        "name": location.name,
    }


@transaction.atomic
def list_inventory(user, workspace_id, *, project_id=None, offset=0, limit=50):
    workspace = authorize(user, workspace_id, Perm.WORKSPACE_READ)
    project = context_project(workspace.id, project_id) if project_id else None
    # Lock the bounded accounts so quantities, reservations and state agree in this response.
    accounts = list(
        StockAccount.objects.select_related("lot__revision__definition", "location")
        .select_for_update(of=("self",))
        .filter(location__workspace=workspace)
        .order_by("created_at", "id")[offset : offset + limit]
    )
    for account in accounts:
        get_revision(user, account.lot.revision_id)
        authorize_current_assertion(user, account)
    lots = PhysicalLot.objects.filter(revision__definition__workspace=workspace).order_by(
        "created_at", "id"
    )[offset : offset + limit]
    for lot in lots:
        get_revision(user, lot.revision_id)
    locations = Location.objects.filter(workspace=workspace).order_by("name", "id")[
        offset : offset + limit
    ]
    batches = (
        WorkBatch.objects.filter(revision__definition__workspace=workspace)
        .filter(**({"project": project} if project else {}))
        .select_related("revision__definition")
        .select_for_update(of=("self",))
        .order_by("created_at", "id")[offset : offset + limit]
    )
    for batch in batches:
        get_revision(user, batch.revision_id)
    return {
        "work_batches": [work_batch_result(batch) for batch in batches],
        "workspace_id": str(workspace.id),
        "project_id": str(project.id) if project else None,
        "accounts": [account_result(account) for account in accounts],
        "locations": [location_result(location) for location in locations],
        "lots": [{"lot_id": str(lot.id), "label": lot.label} for lot in lots],
        "offset": offset,
        "limit": limit,
    }


@transaction.atomic
def account_detail(user, account_id, *, offset=0, limit=50):
    account = get_account(user, account_id, lock=True)
    entries = list(account.entries.order_by("-sequence")[offset : offset + limit])
    reservations = account.reservations.select_related("release").order_by("-created_at", "id")[
        offset : offset + limit
    ]
    batch_ids = [entry.work_batch_id for entry in entries if entry.work_batch_id]
    for batch_id in set(batch_ids):
        get_work_batch(user, batch_id)
    for unit_id in {entry.physical_unit_id for entry in entries if entry.physical_unit_id}:
        from specmate.physical_units.queries import get_unit

        get_unit(user, unit_id)
    return {
        "account": account_result(account),
        "entries": [entry_result(entry) for entry in entries],
        "reservations": [
            {
                **reservation_result(reservation),
                "release": {
                    "reason": reservation.release.reason,
                    "actor_id": reservation.release.actor_id,
                    "request_id": reservation.release.request_id,
                    "created_at": reservation.release.created_at.isoformat(),
                }
                if hasattr(reservation, "release")
                else None,
            }
            for reservation in reservations
        ],
        "offset": offset,
        "limit": limit,
    }


@transaction.atomic
def work_batch_detail(user, work_batch_id, *, offset=0, limit=50):
    batch = get_work_batch(user, work_batch_id, lock=True)
    usage = (
        StockEntry.objects.filter(work_batch=batch)
        .select_related("account__location", "account__lot")
        .order_by("created_at", "id")[offset : offset + limit]
    )
    for entry in usage:
        get_account(user, entry.account_id)
        if entry.physical_unit_id:
            from specmate.physical_units.queries import get_unit

            get_unit(user, entry.physical_unit_id)
    completions = batch.completions.order_by("sequence")[offset : offset + limit]
    return {
        "work_batch": work_batch_result(batch),
        "usage": [entry_result(entry) for entry in usage],
        "completions": [
            {
                "completion_id": str(c.id),
                "sequence": c.sequence,
                "units_completed": c.units_completed,
                "reason": c.reason,
                "assertion_source": c.assertion_source,
                "assertion_status": c.assertion_status,
                "actor_id": c.actor_id,
                "request_id": c.request_id,
                "created_at": c.created_at.isoformat(),
            }
            for c in completions
        ],
        "offset": offset,
        "limit": limit,
    }
