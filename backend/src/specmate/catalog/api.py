from uuid import UUID

from ninja import Query, Router

from specmate.catalog import queries
from specmate.catalog.discovery import SearchCatalog, WhereUsed, search_catalog, where_used
from specmate.operations import ValidationFailed

router = Router(tags=["catalog"])


@router.get("/search")
def search(request, payload: Query[SearchCatalog]):
    return search_catalog(request.user, payload)


@router.get("/where-used")
def uses(request, payload: Query[WhereUsed]):
    return where_used(request.user, payload)


def page(offset, limit):
    if offset < 0 or not 1 <= limit <= 100:
        raise ValidationFailed("Pagination requires offset >= 0 and limit between 1 and 100.")
    return {"offset": offset, "limit": limit}


@router.get("/definitions/{definition_id}")
def get_identity(request, definition_id: UUID, offset: int = 0, limit: int = 50):
    return queries.get_identity(request.user, definition_id, **page(offset, limit))


@router.get("/revisions/{revision_id}")
def get_revision_catalog(request, revision_id: UUID, offset: int = 0, limit: int = 50):
    return queries.get_revision_catalog(request.user, revision_id, **page(offset, limit))
