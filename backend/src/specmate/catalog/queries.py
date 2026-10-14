"""Scoped, bounded catalog reads shared by all adapters."""

from specmate.access.permissions import Perm, authorize
from specmate.catalog.contracts import LotResult, RepresentationResult, VariantResult
from specmate.catalog.models import ManufacturerVariant, PhysicalLot, Representation
from specmate.design.models import Definition
from specmate.operations import NotFound


def variant_result(variant):
    return VariantResult(
        variant_id=variant.id,
        revision_id=variant.revision_id,
        definition_id=variant.revision.definition_id,
        manufacturer=variant.manufacturer,
        part_number=variant.part_number,
        association_basis=variant.association_basis,
    ).model_dump(mode="json")


def representation_result(representation):
    source = representation.source_file
    return RepresentationResult(
        representation_id=representation.id,
        revision_id=representation.revision_id,
        definition_id=representation.revision.definition_id,
        kind=representation.kind,
        label=representation.label,
        source_bundle_revision_id=source.revision_id,
        source_path=source.path,
        sha256=source.blob.sha256,
        media_type=source.media_type,
        rights=source.rights,
    ).model_dump(mode="json")


def get_identity(user, definition_id, *, offset=0, limit=50):
    definition = Definition.objects.filter(id=definition_id).first()
    if definition is None:
        raise NotFound("Definition not found.")
    authorize(user, definition.workspace_id, Perm.WORKSPACE_READ)
    revisions = list(definition.revisions.order_by("number")[offset : offset + limit])
    return {
        "definition_id": str(definition.id),
        "name": definition.name,
        "kind": definition.kind,
        "revisions": [{"revision_id": str(r.id), "number": r.number} for r in revisions],
        "drafts": [
            draft_summary(user, draft)
            for draft in definition.drafts.select_related("base_revision__snapshot")
            .prefetch_related("base_revision__snapshot__dependencies__revision__definition")
            .order_by("id")[offset : offset + limit]
        ],
        "offset": offset,
        "limit": limit,
    }


def get_revision_catalog(user, revision_id, *, offset=0, limit=50):
    from specmate.queries import get_revision

    revision = get_revision(user, revision_id)
    variants = ManufacturerVariant.objects.select_related("revision").filter(revision=revision)
    representations = Representation.objects.select_related(
        "revision", "source_file__blob", "source_file__revision__bundle"
    ).filter(
        revision=revision,
        source_file__revision__bundle__workspace_id=revision.definition.workspace_id,
    )
    lots = PhysicalLot.objects.select_related("revision").filter(revision=revision)
    return {
        "lots": [
            lot_result(lot) for lot in lots.order_by("created_at", "id")[offset : offset + limit]
        ],
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "variants": [
            variant_result(v)
            for v in variants.order_by("created_at", "id")[offset : offset + limit]
        ],
        "representations": [
            representation_result(r)
            for r in representations.order_by("created_at", "id")[offset : offset + limit]
        ],
        "offset": offset,
        "limit": limit,
    }


def lot_result(lot):
    return LotResult(
        lot_id=lot.id,
        revision_id=lot.revision_id,
        definition_id=lot.revision.definition_id,
        variant_id=lot.variant_id,
        label=lot.label,
    ).model_dump(mode="json")


def draft_summary(user, draft):
    from specmate.design.operations import authorize_design_content
    from specmate.queries import get_revision

    authorize_design_content(user, draft.definition, draft.content)
    dependencies = []
    if draft.base_revision_id:
        get_revision(user, draft.base_revision_id)
        for pin in draft.base_revision.snapshot.dependencies.all():
            dependencies.append(str(pin.revision_id))
    return {"draft_id": str(draft.id), "state": draft.state_token, "dependencies": dependencies}


def list_definitions(user, *, workspace_id=None, project_id=None, kind=None, after=None, limit=50):
    """Library definitions of one workspace; a project context lists its references first.

    The project id never limits the list to "owned" definitions: definitions live in the
    workspace collection, and every member reads all of them.
    """
    from django.db.models import Max

    from specmate.catalog.scope import context_first, library_scope, references_definition

    workspace, project = library_scope(user, workspace_id, project_id)
    query = Definition.objects.filter(workspace=workspace).annotate(
        latest_number=Max("revisions__number")
    )
    if kind is not None:
        query = query.filter(kind=kind)
    referenced = references_definition(project) if project is not None else None
    rows = list(
        context_first(query, referenced, after, cursor_error="Definition cursor not found.")[
            : limit + 1
        ]
    )
    results = []
    for row in rows[:limit]:
        result = {
            "definition_id": str(row.id),
            "workspace_id": str(row.workspace_id),
            "kind": row.kind,
            "name": row.name,
            "latest_revision_number": row.latest_number,
        }
        if project is not None:
            result["in_project"] = bool(row.in_project)
        results.append(result)
    return {
        "workspace_id": str(workspace.id),
        "project_id": str(project.id) if project is not None else None,
        "results": results,
        "next_after": results[-1]["definition_id"] if len(rows) > limit else None,
    }
