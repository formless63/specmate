from uuid import UUID

from ninja import Query, Router

from specmate.catalog import queries
from specmate.catalog.discovery import (
    RevisionImpact,
    RevisionLabels,
    SearchCatalog,
    WhereUsed,
    revision_impact,
    revision_labels,
    search_catalog,
    where_used,
)
from specmate.operations import ValidationFailed
from specmate.parts.contracts import KitPage, RecordSelection
from specmate.parts.membership import kits_for_revision
from specmate.parts.records import selected_record

router = Router(tags=["catalog"])


@router.get("/search")
def search(request, payload: Query[SearchCatalog]):
    return search_catalog(request.user, payload)


@router.get("/where-used")
def uses(request, payload: Query[WhereUsed]):
    return where_used(request.user, payload)


@router.get("/revision-impact")
def impact(request, payload: Query[RevisionImpact]):
    return revision_impact(request.user, payload)


@router.get("/revision-labels")
def labels(request, payload: Query[RevisionLabels]):
    return revision_labels(request.user, payload)


def page(offset, limit):
    if offset < 0 or not 1 <= limit <= 100:
        raise ValidationFailed("Pagination requires offset >= 0 and limit between 1 and 100.")
    return {"offset": offset, "limit": limit}


@router.get("/definitions")
def library_definitions(
    request,
    workspace_id: UUID | None = None,
    project_id: UUID | None = None,
    kind: str | None = None,
    after: UUID | None = None,
    limit: int = 50,
):
    if not 1 <= limit <= 100:
        raise ValidationFailed("Pagination requires a limit between 1 and 100.")
    return queries.list_definitions(
        request.user,
        workspace_id=workspace_id,
        project_id=project_id,
        kind=kind,
        after=after,
        limit=limit,
    )


@router.get("/definitions/{definition_id}")
def get_identity(request, definition_id: UUID, offset: int = 0, limit: int = 50):
    return queries.get_identity(request.user, definition_id, **page(offset, limit))


@router.get("/revisions/{revision_id}")
def get_revision_catalog(request, revision_id: UUID, offset: int = 0, limit: int = 50):
    return queries.get_revision_catalog(request.user, revision_id, **page(offset, limit))


@router.get("/revisions/{revision_id}/kits")
def exact_kits(request, revision_id: UUID, payload: Query[KitPage]):
    return kits_for_revision(request.user, revision_id, payload)


@router.get("/definitions/{definition_id}/record")
def selected(request, definition_id: UUID, payload: Query[RecordSelection]):
    return selected_record(request.user, definition_id, payload)
