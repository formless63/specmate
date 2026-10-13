from uuid import UUID

from ninja import Router

from specmate.wire_stock.queries import get_stock, list_stocks

router = Router(tags=["wire stock"])


@router.get("/projects/{project_id}/stocks")
def stocks(request, project_id: UUID):
    return list_stocks(request.user, project_id)


@router.get("/stocks/{draft_id}")
def stock(request, draft_id: UUID):
    return get_stock(request.user, draft_id)
