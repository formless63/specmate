from specmate.access.permissions import Perm, authorize
from specmate.catalog.contracts import RegisterLot, RegisterRepresentation, RegisterVariant
from specmate.catalog.models import ManufacturerVariant, PhysicalLot, Representation
from specmate.catalog.queries import lot_result, representation_result, variant_result
from specmate.design.models import Revision
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.models import SourceBundleFile


def editable_revision(ctx, revision_id):
    revision = get_revision(ctx.user, revision_id)
    authorize(ctx.user, revision.definition.project_id, Perm.DESIGN_EDIT)
    # Serialize duplicate checks without modifying the immutable revision.
    Revision.objects.select_for_update().get(id=revision.id)
    return revision


@operation(
    "catalog.register_variant",
    RegisterVariant,
    summary="Associate an orderable manufacturer identity with an exact design revision.",
)
def register_variant(ctx: Context, p: RegisterVariant) -> dict:
    revision = editable_revision(ctx, p.revision_id)
    if ManufacturerVariant.objects.filter(
        revision=revision, manufacturer=p.manufacturer, part_number=p.part_number
    ).exists():
        raise Conflict("This manufacturer part is already associated with this revision.")
    variant = ManufacturerVariant.objects.create(
        revision=revision,
        manufacturer=p.manufacturer,
        part_number=p.part_number,
        association_basis=p.association_basis,
        registered_by=ctx.user,
    )
    return variant_result(variant)


@operation(
    "catalog.register_representation",
    RegisterRepresentation,
    summary="Associate an immutable source file representation with an exact design revision.",
)
def register_representation(ctx: Context, p: RegisterRepresentation) -> dict:
    revision = editable_revision(ctx, p.revision_id)
    source = get_bundle_revision(ctx.user, p.source_bundle_revision_id)
    if source.bundle.project_id != revision.definition.project_id:
        raise ValidationFailed("Representation source must belong to the definition's project.")
    source_file = (
        SourceBundleFile.objects.select_related("blob", "revision")
        .filter(revision=source, path=p.source_path)
        .first()
    )
    if source_file is None:
        raise NotFound("Source file not found.")
    if Representation.objects.filter(
        revision=revision, kind=p.kind, source_file=source_file
    ).exists():
        raise Conflict("This source representation is already associated with this revision.")
    representation = Representation.objects.create(
        revision=revision,
        kind=p.kind,
        label=p.label,
        source_file=source_file,
        registered_by=ctx.user,
    )
    return representation_result(representation)


@operation(
    "catalog.register_lot",
    RegisterLot,
    summary="Register a physical lot identity pinned to a revision; no stock transaction occurs.",
)
def register_lot(ctx: Context, p: RegisterLot) -> dict:
    revision = editable_revision(ctx, p.revision_id)
    variant = None
    if p.variant_id:
        variant = (
            ManufacturerVariant.objects.select_related("revision__definition")
            .filter(id=p.variant_id)
            .first()
        )
        if variant is None:
            raise NotFound("Variant not found.")
        authorize(ctx.user, variant.revision.definition.project_id, Perm.PROJECT_READ)
        if variant.revision_id != revision.id:
            raise ValidationFailed("Lot and manufacturer variant must pin the same revision.")
    lot = PhysicalLot.objects.create(
        revision=revision,
        variant=variant,
        label=p.label,
        registered_by=ctx.user,
    )
    return lot_result(lot)


def authorize_catalog_replay(ctx: Context, p, stored_result: dict) -> None:
    """Recheck current authority without repeating an append or a duplicate check.

    The shared executor supplies the already-validated payload and its stored result.
    Registration results only disclose records scoped by these pinned references.
    """
    revision = get_revision(ctx.user, p.revision_id)
    authorize(ctx.user, revision.definition.project_id, Perm.DESIGN_EDIT)
    if isinstance(p, RegisterRepresentation):
        source = get_bundle_revision(ctx.user, p.source_bundle_revision_id)
        if source.bundle.project_id != revision.definition.project_id:
            raise ValidationFailed("Representation source must belong to the definition's project.")
    if isinstance(p, RegisterLot) and p.variant_id:
        variant = (
            ManufacturerVariant.objects.select_related("revision__definition")
            .filter(id=p.variant_id)
            .first()
        )
        if variant is None:
            raise NotFound("Variant not found.")
        authorize(ctx.user, variant.revision.definition.project_id, Perm.PROJECT_READ)
        if variant.revision_id != revision.id:
            raise ValidationFailed("Lot and manufacturer variant must pin the same revision.")
