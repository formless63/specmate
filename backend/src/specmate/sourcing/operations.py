from django.db import IntegrityError, transaction
from django.utils import timezone

from specmate.access.models import Workspace
from specmate.access.permissions import Perm, authorize
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.queries import get_revision
from specmate.sourcing.contracts import RecordOffer, SourcingReadRequest
from specmate.sourcing.models import SupplierOffer
from specmate.sourcing.queries import offer_result, report


def offer_scope(ctx: Context, p: RecordOffer) -> str:
    """Current inventory authority and revision readability, before any retained lookup."""
    workspace = authorize(ctx.user, p.workspace_id, Perm.ITEM_CREATE)
    for rid in (p.revision_id, p.substitute_for_revision_id):
        if rid is not None:
            get_revision(ctx.user, rid)
    return f"workspace:{workspace.id}"


@operation(
    "sourcing.record_offer",
    RecordOffer,
    summary="Record a dated, reviewed supplier offer; the actor is the reviewer.",
    authorize_replay=lambda ctx, p, stored: offer_scope(ctx, p),
    idempotency_scope=offer_scope,
    access=Perm.ITEM_CREATE,
)
def record_offer(ctx: Context, p: RecordOffer):
    offer_scope(ctx, p)
    workspace = Workspace.objects.select_for_update().get(id=p.workspace_id)
    revision = get_revision(ctx.user, p.revision_id)
    if revision.definition.workspace_id != workspace.id:
        raise ValidationFailed("The offered revision must belong to this workspace.")
    replaced = None
    if p.substitute_for_revision_id:
        replaced = get_revision(ctx.user, p.substitute_for_revision_id)
        if replaced.definition.workspace_id != workspace.id:
            raise ValidationFailed("The replaced revision must belong to this workspace.")
    if p.offered_on > timezone.localdate():
        raise ValidationFailed("An offer cannot be dated in the future.")
    previous = None
    if p.supersedes_offer_id:
        previous = (
            SupplierOffer.objects.select_for_update()
            .filter(id=p.supersedes_offer_id, workspace=workspace)
            .first()
        )
        if previous is None:
            raise ValidationFailed("The superseded offer is not in this workspace.")
        if previous.revision_id != revision.id or previous.substitute_for_id != (
            replaced.id if replaced else None
        ):
            raise ValidationFailed("A superseding offer must cover the same revision and need.")
        if p.offered_on < previous.offered_on:
            raise ValidationFailed("A superseding offer cannot predate the offer it replaces.")
        if SupplierOffer.objects.filter(supersedes=previous).exists():
            raise Conflict("This offer has already been superseded.")
    price = p.price
    try:
        with transaction.atomic():
            offer = SupplierOffer.objects.create(
                workspace=workspace,
                revision=revision,
                supplier=p.supplier,
                supplier_ref=p.supplier_ref,
                source=p.source,
                review_basis=p.review_basis,
                reviewed_by=ctx.user,
                offered_on=p.offered_on,
                valid_until=p.valid_until,
                price_amount=price.amount if price else None,
                price_currency=price.currency if price else None,
                price_unit=price.per_unit if price else "ea",
                availability=p.availability,
                lead_time_days=p.lead_time_days,
                substitute_for=replaced,
                substitution_basis=p.substitution_basis,
                supersedes=previous,
                request_id=ctx.request_id,
            )
    except IntegrityError:
        raise Conflict("This offer has already been superseded.") from None
    offer = SupplierOffer.objects.select_related("reviewed_by").get(id=offer.id)
    return offer_result(offer)


@operation(
    "sourcing.report",
    SourcingReadRequest,
    summary="Combine a frozen BOM or material plan with live stock and reviewed offers.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def sourcing_report(ctx: Context, p: SourcingReadRequest):
    return report(
        ctx.user, p.revision_id, purpose=p.purpose, as_of=p.as_of, max_age_days=p.max_age_days
    )
