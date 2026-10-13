from decimal import Decimal

from django.db import transaction
from django.db.models import Sum

from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import PhysicalLot
from specmate.inventory.contracts import CANONICAL_UNITS, AccountResult, ReservationResult
from specmate.inventory.models import Location, Reservation, StockAccount
from specmate.operations import NotFound


def decimal_text(value):
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def get_lot(user, lot_id):
    lot = PhysicalLot.objects.select_related("revision__definition").filter(id=lot_id).first()
    if lot is None:
        raise NotFound("Lot not found.")
    authorize(user, lot.revision.definition.project_id, Perm.PROJECT_READ)
    return lot


def get_location(user, location_id):
    location = Location.objects.filter(id=location_id).first()
    if location is None:
        raise NotFound("Location not found.")
    authorize(user, location.project_id, Perm.PROJECT_READ)
    return location


def get_account(user, account_id, *, lock=False):
    query = StockAccount.objects.select_related("lot__revision__definition", "location")
    if lock:
        query = query.select_for_update(of=("self",))
    account = query.filter(id=account_id).first()
    if account is None:
        raise NotFound("Stock account not found.")
    authorize(user, account.location.project_id, Perm.PROJECT_READ)
    authorize(user, account.lot.revision.definition.project_id, Perm.PROJECT_READ)
    return account


def latest_entry(account):
    return account.entries.order_by("-sequence").first()


def reserved_quantity(account):
    return account.reservations.filter(release__isnull=True).aggregate(total=Sum("quantity"))[
        "total"
    ] or Decimal(0)


def account_result(account):
    entry = latest_entry(account)
    quantity = entry.after if entry else None
    reserved = reserved_quantity(account)
    return AccountResult(
        account_id=account.id,
        project_id=account.location.project_id,
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
        available_quantity=decimal_text(quantity - reserved) if quantity is not None else None,
        state=str(account.state),
        assertion_source=entry.assertion_source if entry else "Not established",
        assertion_status=entry.assertion_status if entry else "declared",
    ).model_dump(mode="json")


def reservation_result(reservation):
    return ReservationResult(
        reservation_id=reservation.id,
        account_id=reservation.account_id,
        quantity=decimal_text(reservation.quantity),
        amount=decimal_text(reservation.amount),
        unit=reservation.unit,
        purpose=reservation.purpose,
        status="released" if hasattr(reservation, "release") else "active",
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


def location_result(location):
    return {
        "location_id": str(location.id),
        "project_id": str(location.project_id),
        "name": location.name,
    }


@transaction.atomic
def list_inventory(user, project_id, *, offset=0, limit=50):
    authorize(user, project_id, Perm.PROJECT_READ)
    # Lock the bounded accounts so quantities, reservations and state agree in this response.
    accounts = list(
        StockAccount.objects.select_related("lot__revision__definition", "location")
        .select_for_update(of=("self",))
        .filter(location__project_id=project_id)
        .order_by("created_at", "id")[offset : offset + limit]
    )
    lots = PhysicalLot.objects.filter(revision__definition__project_id=project_id).order_by(
        "created_at", "id"
    )[offset : offset + limit]
    locations = Location.objects.filter(project_id=project_id).order_by("name", "id")[
        offset : offset + limit
    ]
    return {
        "project_id": str(project_id),
        "accounts": [account_result(account) for account in accounts],
        "locations": [location_result(location) for location in locations],
        "lots": [{"lot_id": str(lot.id), "label": lot.label} for lot in lots],
        "offset": offset,
        "limit": limit,
    }


@transaction.atomic
def account_detail(user, account_id, *, offset=0, limit=50):
    account = get_account(user, account_id, lock=True)
    entries = account.entries.order_by("-sequence")[offset : offset + limit]
    reservations = account.reservations.select_related("release").order_by("-created_at", "id")[
        offset : offset + limit
    ]
    return {
        "account": account_result(account),
        "entries": [
            {
                "entry_id": str(entry.id),
                "sequence": entry.sequence,
                "kind": entry.kind,
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
            }
            for entry in entries
        ],
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
