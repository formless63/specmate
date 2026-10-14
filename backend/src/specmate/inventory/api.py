from uuid import UUID

from ninja import Query, Router, Schema
from pydantic import Field

from specmate.inventory.queries import account_detail, list_inventory, work_batch_detail

router = Router(tags=["inventory"])


class Page(Schema):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


@router.get("/workspaces/{workspace_id}")
def list_workspace(request, workspace_id: UUID, page: Query[Page], project_id: UUID | None = None):
    return list_inventory(request.user, workspace_id, project_id=project_id, **page.dict())


@router.get("/accounts/{account_id}")
def get_account(request, account_id: UUID, page: Query[Page]):
    return account_detail(request.user, account_id, **page.dict())


@router.get("/work-batches/{work_batch_id}")
def get_work_batch(request, work_batch_id: UUID, page: Query[Page]):
    return work_batch_detail(request.user, work_batch_id, **page.dict())
