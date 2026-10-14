from django.db import IntegrityError, transaction

from specmate.access.models import Workspace
from specmate.access.permissions import Perm, authorize
from specmate.integrations import adapter
from specmate.integrations.contracts import (
    CreateIntegration,
    ExportNeeds,
    ImportObservations,
    UpdateIntegration,
)
from specmate.integrations.models import (
    ExportRecord,
    ExternalObservation,
    ImportRun,
    Integration,
)
from specmate.integrations.queries import (
    export_result,
    get_integration,
    import_result,
    integration_result,
    sha256,
)
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)
from specmate.queries import get_revision


def admin_scope(ctx: Context, p) -> str:
    if isinstance(p, CreateIntegration):
        workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_ADMIN)
    else:
        workspace = authorize(
            ctx.user,
            get_integration(ctx.user, p.integration_id, Perm.WORKSPACE_ADMIN).workspace_id,
            Perm.WORKSPACE_ADMIN,
        )
    return f"workspace:{workspace.id}"


def run_scope(ctx: Context, p) -> str:
    """Authority is re-evaluated before any retained lookup (replay included)."""
    integration = get_integration(ctx.user, p.integration_id, Perm.ITEM_CREATE)
    needed = Perm.INVENTORY_MANAGE if _manages(p) else Perm.ITEM_CREATE
    authorize(ctx.user, integration.workspace_id, needed)
    return f"workspace:{integration.workspace_id}"


def _manages(p) -> bool:
    return isinstance(p, ExportNeeds) or p.field == "stock_observation"


def _check_columns(columns):
    known = set(adapter.EXPORT_COLUMNS)
    for names in adapter.IMPORT_COLUMNS.values():
        known.update(names)
    unknown = sorted(set(columns) - known)
    if unknown:
        raise ValidationFailed(f"Unknown canonical columns: {', '.join(unknown)}.")
    if len(set(columns.values())) != len(columns):
        raise ValidationFailed("Two canonical columns cannot map to one external column.")


@operation(
    "integration.create",
    CreateIntegration,
    summary="Admin: declare an optional integration and which system owns each field.",
    idempotency_scope=admin_scope,
    authorize_replay=lambda ctx, p, stored: admin_scope(ctx, p),
    access=Perm.WORKSPACE_ADMIN,
)
def create_integration(ctx: Context, p: CreateIntegration):
    admin_scope(ctx, p)
    _check_columns(p.columns)
    workspace = Workspace.objects.select_for_update().get(id=p.workspace_id)
    try:
        with transaction.atomic():
            integration = Integration.objects.create(
                workspace=workspace,
                name=p.name,
                ownership=dict(p.ownership),
                columns=p.columns,
                created_by=ctx.user,
                updated_by=ctx.user,
            )
    except IntegrityError:
        raise Conflict("An integration with this name already exists.") from None
    return integration_result(get_integration(ctx.user, integration.id))


@operation(
    "integration.update",
    UpdateIntegration,
    summary="Admin: change field ownership or mappings, or disable an integration.",
    requires_expected_state=True,
    idempotency_scope=admin_scope,
    authorize_replay=lambda ctx, p, stored: admin_scope(ctx, p),
    access=Perm.WORKSPACE_ADMIN,
)
def update_integration(ctx: Context, p: UpdateIntegration):
    admin_scope(ctx, p)
    _check_columns(p.columns)
    integration = Integration.objects.select_for_update().get(id=p.integration_id)
    if str(integration.state) != str(ctx.expected_state):
        raise Conflict("The integration changed; reload and retry.")
    import uuid

    integration.ownership = dict(p.ownership)
    integration.columns = p.columns
    integration.enabled = p.enabled
    integration.updated_by = ctx.user
    integration.state = uuid.uuid4()
    integration.save()
    return integration_result(get_integration(ctx.user, integration.id))


def _active(ctx, integration_id, perm):
    integration = get_integration(ctx.user, integration_id, perm)
    integration = Integration.objects.select_for_update().get(id=integration.id)
    if not integration.enabled:
        raise Conflict("This integration is disabled.")
    return integration


@operation(
    "integration.import",
    ImportObservations,
    summary=(
        "Import a CSV/JSON file as dated, attributed observations; never writes "
        "engineering facts or the stock ledger."
    ),
    idempotency_scope=run_scope,
    authorize_replay=lambda ctx, p, stored: run_scope(ctx, p),
    access=Perm.ITEM_CREATE,
)
def import_observations(ctx: Context, p: ImportObservations):
    run_scope(ctx, p)
    integration = _active(ctx, p.integration_id, Perm.ITEM_CREATE)
    if integration.ownership.get(p.field) != "external":
        raise ValidationFailed(f"This integration does not declare {p.field} externally owned.")
    if p.field == "stock_observation":
        authorize(ctx.user, integration.workspace_id, Perm.INVENTORY_MANAGE)
    digest = sha256(p.content)
    earlier = (
        ImportRun.objects.select_related("actor")
        .filter(integration=integration, field=p.field, content_sha256=digest)
        .first()
    )
    if earlier is not None:
        return import_result(earlier, duplicate=True)
    rows = adapter.read_rows(p.content, p.file_format, integration.columns)
    accepted, rejections = [], []
    cache: dict[str, object] = {}
    for number, raw in enumerate(rows, start=1):
        row, reason = adapter.validate_row(p.field, raw)
        revision = None
        if row is not None:
            if row.revision_id not in cache:
                try:
                    found = get_revision(ctx.user, row.revision_id)
                    ok = found.definition.workspace_id == integration.workspace_id
                    cache[row.revision_id] = found if ok else None
                except (NotFound, PermissionDenied, ValueError, ValidationFailed):
                    cache[row.revision_id] = None
            revision = cache[row.revision_id]
            if revision is None:
                reason = "revision_id: not an item revision in this workspace"
        if reason is not None:
            if len(rejections) < 100:  # the exact count is row_count - accepted_count
                rejections.append({"row": number, "reason": reason})
            continue
        accepted.append((number, row, revision))
    run = ImportRun.objects.create(
        integration=integration,
        workspace_id=integration.workspace_id,
        field=p.field,
        file_name=p.file_name,
        file_format=p.file_format,
        content_sha256=digest,
        row_count=len(rows),
        accepted_count=len(accepted),
        rejections=rejections,
        actor=ctx.user,
        request_id=ctx.request_id,
    )
    ExternalObservation.objects.bulk_create(
        [_observation(run, p.field, n, row, rev) for n, row, rev in accepted]
    )
    return import_result(run)


def _observation(run, field, number, row, revision):
    common = {
        "run": run,
        "workspace_id": run.workspace_id,
        "revision": revision,
        "kind": field,
        "row_number": number,
        "external_ref": "",
    }
    if field == "supplier_offer":
        return ExternalObservation(
            **{**common, "external_ref": row.supplier_ref or ""},
            observed_on=row.offered_on,
            valid_until=row.valid_until,
            supplier=row.supplier,
            price_amount=row.price_amount,
            price_currency=row.price_currency,
            price_unit=row.price_unit,
            availability=row.availability or "unknown",
            lead_time_days=row.lead_time_days,
        )
    return ExternalObservation(
        **{**common, "external_ref": row.external_ref or ""},
        observed_on=row.observed_on,
        quantity_amount=row.quantity_amount,
        quantity_unit=row.quantity_unit,
        location_label=row.location_label or "",
    )


@operation(
    "integration.export_needs",
    ExportNeeds,
    summary="Explicitly export a frozen BOM or material plan's needs to a file, with a record.",
    idempotency_scope=run_scope,
    authorize_replay=lambda ctx, p, stored: run_scope(ctx, p),
    access=Perm.INVENTORY_MANAGE,
)
def export_needs(ctx: Context, p: ExportNeeds):
    from specmate.sourcing.queries import extract_needs

    run_scope(ctx, p)
    integration = _active(ctx, p.integration_id, Perm.INVENTORY_MANAGE)
    if integration.ownership.get("needs") != "specmate":
        raise ValidationFailed("This integration does not declare needs for export.")
    revision = get_revision(ctx.user, p.revision_id)
    if revision.definition.workspace_id != integration.workspace_id:
        raise ValidationFailed("The plan must belong to the integration's workspace.")
    needs, unresolved = extract_needs(ctx.user, revision, p.purpose)
    rows = [
        {
            "revision_id": n["revision_id"],
            "unit": n["unit"],
            # Unknown quantities export blank, never zero.
            "required_amount": _amount(n["amount"]),
            "net_amount": _amount(n["net"]),
            "waste_status": n.get("waste_status"),
            "origin_kind": n["origin"].get("kind"),
            "origin_address": n["origin"].get("address") or n["origin"].get("local_id"),
        }
        for n in needs
    ]
    content = adapter.write_rows(rows, p.file_format, integration.columns)
    record = ExportRecord.objects.create(
        integration=integration,
        workspace_id=integration.workspace_id,
        plan_revision=revision,
        purpose=p.purpose,
        file_format=p.file_format,
        content=content,
        content_sha256=sha256(content),
        row_count=len(rows),
        unresolved_count=len(unresolved),
        actor=ctx.user,
        request_id=ctx.request_id,
    )
    return export_result(record, unresolved)


def _amount(value):
    from specmate.inventory.queries import decimal_text

    return None if value is None else decimal_text(value)
