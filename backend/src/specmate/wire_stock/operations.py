"""Stock commands share catalog identity, transactions, audit and state tokens."""

from uuid import UUID

from pydantic import Field

from specmate.access.permissions import Perm
from specmate.catalog.scope import creation_workspace
from specmate.design.models import Definition, Draft
from specmate.design.operations import check_state, draft_state, scoped_draft
from specmate.operations import Context, NotFound, operation
from specmate.wire_stock.queries import stock_record
from specmate.wire_stock.schemas import StockSpecification, StrictModel


class CreateStock(StrictModel):
    # Omitted: the actor's workspace. Stock is a library definition, never project-owned.
    workspace_id: UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    stock: StockSpecification
    # Navigation context: the project that will reference the new stock.
    project_id: UUID | None = None


@operation(
    "wire_stock.create",
    CreateStock,
    summary="Create standalone typed wire stock.",
    idempotency_scope=lambda ctx, p: stock_scope(ctx, p),
    authorize_replay=lambda ctx, p, stored: stock_scope(ctx, p),
    access=Perm.ITEM_CREATE,
)
def create_stock(ctx: Context, p: CreateStock) -> dict:
    workspace = creation_workspace(ctx.user, p.workspace_id)
    definition = Definition.objects.create(
        workspace=workspace, kind="wire_stock", name=p.name, created_by=ctx.user
    )
    draft = Draft.objects.create(
        definition=definition,
        content={"stock": p.stock.model_dump(mode="json")},
        updated_by=ctx.user,
    )
    from specmate.access.projects import reference_created_item

    reference_created_item(ctx, workspace, p.project_id, "definition", definition, "created here")
    return {
        "definition_id": str(definition.id),
        "workspace_id": str(workspace.id),
        "name": definition.name,
        **draft_state(draft),
    }


class UpdateStock(StrictModel):
    draft_id: UUID
    stock: StockSpecification


@operation(
    "wire_stock.update",
    UpdateStock,
    summary="Replace typed stock construction.",
    requires_expected_state=True,
    idempotency_scope=lambda ctx, p: stock_scope(ctx, p),
    authorize_replay=lambda ctx, p, stored: stock_scope(ctx, p),
    access=Perm.DESIGN_EDIT,
)
def update_stock(ctx: Context, p: UpdateStock) -> dict:
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    if draft.definition.kind != "wire_stock":
        raise NotFound("Stock draft not found.")
    check_state(ctx, draft)
    draft.content = {**draft.content, "stock": p.stock.model_dump(mode="json")}
    draft.version += 1
    draft.updated_by = ctx.user
    draft.save(update_fields=["content", "version", "updated_by", "updated_at"])
    return stock_record(draft)


class FreezeStock(StrictModel):
    draft_id: UUID


@operation(
    "wire_stock.freeze",
    FreezeStock,
    summary="Freeze a typed stock as an exact revision.",
    requires_expected_state=True,
    idempotency_scope=lambda ctx, p: stock_scope(ctx, p),
    authorize_replay=lambda ctx, p, stored: stock_scope(ctx, p),
    access=Perm.DESIGN_FREEZE,
)
def freeze_stock(ctx: Context, p: FreezeStock) -> dict:
    from specmate.design.operations import CaptureDraft, freeze_draft
    from specmate.operations import ValidationFailed
    from specmate.wire_stock.schemas import validate_stock_content

    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE, lock=True)
    if draft.definition.kind != "wire_stock":
        raise NotFound("Stock draft not found.")
    check_state(ctx, draft)
    if "stock" not in draft.content:
        raise ValidationFailed("Stock construction is required to freeze typed stock.")
    validate_stock_content(draft.content)
    dependencies = (
        list(draft.base_revision.snapshot.dependencies.values_list("revision_id", flat=True))
        if draft.base_revision_id
        else []
    )
    return freeze_draft(ctx, CaptureDraft(draft_id=p.draft_id, dependencies=dependencies))


def stock_scope(ctx, payload):
    from specmate.operations.scope import workspace_scope

    permission = Perm.DESIGN_FREEZE if isinstance(payload, FreezeStock) else Perm.DESIGN_EDIT
    if isinstance(payload, CreateStock):
        workspace = creation_workspace(ctx.user, payload.workspace_id)
        return workspace_scope(ctx, workspace.id, Perm.ITEM_CREATE)
    draft = scoped_draft(ctx, payload.draft_id, permission)
    if draft.definition.kind != "wire_stock":
        raise NotFound("Stock draft not found.")
    return workspace_scope(ctx, draft.definition.workspace_id, permission)
