from uuid import UUID

from ninja import Router

from specmate.wire_stock.queries import get_stock, list_stocks

router = Router(tags=["wire stock"])


@router.get("/stocks")
def stocks(request, workspace_id: UUID | None = None, project_id: UUID | None = None):
    return list_stocks(request.user, workspace_id, project_id)


@router.get("/stocks/{draft_id}")
def stock(request, draft_id: UUID):
    return get_stock(request.user, draft_id)
