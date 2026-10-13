from uuid import UUID

from ninja import Router

from specmate.passive_passages import queries

router = Router(tags=["passive passages"])


@router.get("/revisions/{revision_id}")
def model(request, revision_id: UUID):
    return queries.result(request.user, revision_id)
