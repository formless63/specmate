from uuid import UUID

from ninja import Query, Router, Schema
from pydantic import Field

from specmate.physical_units.queries import list_units, unit_detail, work_units

router = Router(tags=["physical-units"])


class Page(Schema):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


@router.get("/projects/{project_id}")
def get_project_units(request, project_id: UUID, page: Query[Page]):
    return list_units(request.user, project_id, **page.dict())


@router.get("/units/{unit_id}")
def get_physical_unit(request, unit_id: UUID, page: Query[Page]):
    return unit_detail(request.user, unit_id, **page.dict())


@router.get("/work-batches/{work_batch_id}")
def get_work_units(request, work_batch_id: UUID, page: Query[Page]):
    return work_units(request.user, work_batch_id, **page.dict())
