"""Stock commands share catalog identity, transactions, audit and state tokens."""

from uuid import UUID

from pydantic import Field

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Definition, Draft
from specmate.design.operations import check_state, draft_state, scoped_draft
from specmate.operations import Context, NotFound, operation
from specmate.wire_stock.schemas import StockSpecification, StrictModel


class CreateStock(StrictModel):
    project_id: UUID
    name: str = Field(min_length=1, max_length=200)
    stock: StockSpecification


@operation("wire_stock.create", CreateStock, summary="Create standalone typed wire stock.")
def create_stock(ctx: Context, p: CreateStock) -> dict:
    project = authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    definition = Definition.objects.create(
        project=project, kind="wire_stock", name=p.name, created_by=ctx.user
    )
    draft = Draft.objects.create(
        definition=definition,
        content={"stock": p.stock.model_dump(mode="json")},
        updated_by=ctx.user,
    )
    return {"definition_id": str(definition.id), "name": definition.name, **draft_state(draft)}


class UpdateStock(StrictModel):
    draft_id: UUID
    stock: StockSpecification


@operation(
    "wire_stock.update",
    UpdateStock,
    summary="Replace typed stock construction.",
    requires_expected_state=True,
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
    return {
        "definition_id": str(draft.definition_id),
        "name": draft.definition.name,
        **draft_state(draft),
    }


class FreezeStock(StrictModel):
    draft_id: UUID


@operation(
    "wire_stock.freeze",
    FreezeStock,
    summary="Freeze a typed stock as an exact revision.",
    requires_expected_state=True,
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
    return freeze_draft(ctx, CaptureDraft(draft_id=p.draft_id))
