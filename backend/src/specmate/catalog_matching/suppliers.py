"""Exact catalog assertions suggest correspondence, never engineering equivalence."""

from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import ManufacturerVariant
from specmate.catalog_matching.contracts import SuggestSupplierMatches, SupplierSuggestions
from specmate.catalog_matching.queries import current_actor, revision_identity
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.queries import get_revision

MAX_INSPECTED_VARIANTS = 2000


@operation(
    "catalog.suggest_supplier_matches",
    SuggestSupplierMatches,
    supports_idempotency=False,
    summary=(
        "Suggest distinct exact workspace revisions sharing an asserted manufacturer and part"
        " number."
    ),
    access=Perm.WORKSPACE_READ,
)
def suggest_supplier_matches(ctx: Context, p: SuggestSupplierMatches):
    actor = current_actor(ctx.user)
    source = get_revision(actor, p.source_revision_id)
    # Suggestions come from the source's workspace library; pins never cross workspaces.
    target_workspace = authorize(actor, source.definition.workspace_id, Perm.WORKSPACE_READ)
    variant = ManufacturerVariant.objects.filter(id=p.source_variant_id).first()
    if variant is None:
        raise NotFound("Source catalog association not found.")
    get_revision(actor, variant.revision_id)
    candidates = ManufacturerVariant.objects.select_related(
        "revision__definition", "revision__snapshot"
    ).filter(revision__definition__workspace=target_workspace)
    cursor = None
    if p.after is not None:
        cursor = candidates.filter(id=p.after).first()
        if cursor is None:
            raise NotFound("Supplier suggestion cursor not found.")
    # Resolve supplied references before disclosing whether their identifiers agree.
    if variant.revision_id != source.id:
        raise NotFound("Source catalog association not found.")
    candidates = candidates.filter(
        manufacturer=variant.manufacturer, part_number=variant.part_number
    ).exclude(revision__definition_id=source.definition_id)
    if cursor is not None:
        if not candidates.filter(id=cursor.id).exists():
            raise NotFound("Supplier suggestion cursor not found.")
        candidates = candidates.filter(id__gt=cursor.id)
    if not 1 <= p.limit <= 50:
        raise ValidationFailed("Supplier suggestion limit must be between 1 and 50.")
    visible = []
    truncated = False
    for index, target_variant in enumerate(candidates.order_by("id").iterator(chunk_size=100)):
        if index >= MAX_INSPECTED_VARIANTS:
            truncated = True
            break
        target = target_variant.revision
        visible.append(
            {
                "source_variant_id": str(variant.id),
                "target_variant_id": str(target_variant.id),
                "manufacturer": variant.manufacturer,
                "part_number": variant.part_number,
                "source_association_basis": variant.association_basis,
                "target_association_basis": target_variant.association_basis,
                "target": revision_identity(target),
                "match_basis": "exact_manufacturer_and_part_number",
            }
        )
        if len(visible) > p.limit:
            break
    next_after = (
        visible[p.limit - 1]["target_variant_id"]
        if len(visible) > p.limit
        else (visible[-1]["target_variant_id"] if truncated and visible else None)
    )
    return SupplierSuggestions.model_validate(
        {
            "source": revision_identity(source),
            "workspace_id": str(target_workspace.id),
            "results": visible[: p.limit],
            "next_after": next_after,
            "inspection_truncated": truncated,
        }
    ).model_dump(mode="json")
