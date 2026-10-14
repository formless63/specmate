"""Controlled assertions of actual units and their relationship to planned work."""

from specmate.access.models import Workspace
from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import ManufacturerVariant, PhysicalLot
from specmate.inventory.queries import get_work_batch, work_batch_result
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.scope import workspace_scope
from specmate.physical_units.contracts import LinkWorkUnit, RegisterPhysicalUnit
from specmate.physical_units.models import PhysicalUnit, WorkUnitLink
from specmate.physical_units.queries import get_unit, link_result, unit_result
from specmate.queries import get_revision


def _unit_references(ctx, p):
    revision = get_revision(ctx.user, p.revision_id)
    authorize(ctx.user, revision.definition.workspace_id, Perm.INVENTORY_MANAGE)
    lot = None
    if p.lot_id:
        lot = PhysicalLot.objects.select_related("revision__definition").filter(id=p.lot_id).first()
        if lot is None:
            raise NotFound("Lot not found.")
        get_revision(ctx.user, lot.revision_id)
        if lot.revision_id != revision.id:
            raise ValidationFailed("Unit and actual lot must pin the same revision.")
    variant = None
    if p.variant_id:
        variant = (
            ManufacturerVariant.objects.select_related("revision__definition")
            .filter(id=p.variant_id)
            .first()
        )
        if variant is None:
            raise NotFound("Variant not found.")
        get_revision(ctx.user, variant.revision_id)
        if variant.revision_id != revision.id:
            raise ValidationFailed("Unit and variant must pin the same revision.")
    if lot and lot.variant_id and variant and lot.variant_id != variant.id:
        raise ValidationFailed("Unit and actual lot name different manufacturer variants.")
    if lot and lot.variant_id and variant is None:
        variant = lot.variant
    return revision, lot, variant


def _work_references(ctx, p):
    unit = get_unit(ctx.user, p.unit_id)
    batch = get_work_batch(ctx.user, p.work_batch_id)
    authorize(ctx.user, unit.workspace_id, Perm.INVENTORY_MANAGE)
    if (
        unit.workspace_id != batch.revision.definition.workspace_id
        or unit.revision_id != batch.revision_id
    ):
        raise ValidationFailed("Unit and planned work must share the exact workspace and revision.")
    return unit, batch


def _scope(ctx, p):
    if isinstance(p, RegisterPhysicalUnit):
        revision, _, _ = _unit_references(ctx, p)
        return workspace_scope(ctx, revision.definition.workspace_id)
    unit, _ = _work_references(ctx, p)
    return workspace_scope(ctx, unit.workspace_id)


def _replay(ctx, p, stored_result):
    _scope(ctx, p)


def _require_key(ctx):
    if not ctx.idempotency_key:
        raise ValidationFailed("Physical-unit writes require an idempotency key.")


@operation(
    "physical_units.register",
    RegisterPhysicalUnit,
    summary="Assert one obtained or assembled serialized subject at an exact revision.",
    authorize_replay=_replay,
    idempotency_scope=_scope,
)
def register_unit(ctx: Context, p: RegisterPhysicalUnit):
    revision, lot, variant = _unit_references(ctx, p)
    _require_key(ctx)
    workspace = Workspace.objects.select_for_update().get(id=revision.definition.workspace_id)
    authorize(ctx.user, workspace.id, Perm.INVENTORY_MANAGE)
    if PhysicalUnit.objects.filter(workspace=workspace, serial=p.serial).exists():
        raise Conflict("This serial is already registered in the workspace.")
    unit = PhysicalUnit.objects.create(
        workspace=workspace,
        revision=revision,
        lot=lot,
        variant=variant,
        serial=p.serial,
        origin=p.origin,
        assertion_source=p.assertion_source,
        assertion_status=p.assertion_status,
        registered_by=ctx.user,
        request_id=ctx.request_id,
    )
    return unit_result(unit)


@operation(
    "physical_units.link_work",
    LinkWorkUnit,
    summary="Associate an actual subject with one exact planned job or batch.",
    requires_expected_state=True,
    authorize_replay=_replay,
    idempotency_scope=_scope,
)
def link_work_unit(ctx: Context, p: LinkWorkUnit):
    unit, batch = _work_references(ctx, p)
    _require_key(ctx)
    # Serialize all work writes on the target state token.
    batch = get_work_batch(ctx.user, batch.id, lock=True)
    authorize(ctx.user, unit.workspace_id, Perm.INVENTORY_MANAGE)
    if str(batch.state) != ctx.require_expected_state():
        raise Conflict("Work state changed.", details={"current": work_batch_result(batch)})
    unit = get_unit(ctx.user, unit.id, lock=True)
    authorize(ctx.user, unit.workspace_id, Perm.INVENTORY_MANAGE)
    if WorkUnitLink.objects.filter(unit=unit).exists():
        raise Conflict("This physical unit is already linked to planned work.")
    link = WorkUnitLink.objects.create(
        unit=unit,
        work_batch=batch,
        assertion_source=p.assertion_source,
        assertion_status=p.assertion_status,
        linked_by=ctx.user,
        request_id=ctx.request_id,
    )
    batch.refresh_from_db(fields=["state"])
    return {
        "link": link_result(link),
        "unit": unit_result(unit),
        "work_batch": work_batch_result(batch),
    }
