from uuid import UUID

from ninja import Query, Router, Schema
from pydantic import Field

from specmate.inventory.queries import account_detail, list_inventory, work_batch_detail

router = Router(tags=["inventory"])


class Page(Schema):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


@router.get("/projects/{project_id}")
def list_project(request, project_id: UUID, page: Query[Page]):
    return list_inventory(request.user, project_id, **page.dict())


@router.get("/accounts/{account_id}")
def get_account(request, account_id: UUID, page: Query[Page]):
    return account_detail(request.user, account_id, **page.dict())


@router.get("/work-batches/{work_batch_id}")
def get_work_batch(request, work_batch_id: UUID, page: Query[Page]):
    return work_batch_detail(request.user, work_batch_id, **page.dict())
