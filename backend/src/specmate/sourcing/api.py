from datetime import date
from typing import Literal
from uuid import UUID

from ninja import Query, Router, Schema
from pydantic import Field

from specmate.sourcing.queries import list_offers, report

router = Router(tags=["sourcing"])


class Page(Schema):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


@router.get("/workspaces/{workspace_id}/offers")
def offers(request, workspace_id: UUID, page: Query[Page], revision_id: UUID | None = None):
    return list_offers(request.user, workspace_id, revision_id=revision_id, **page.dict())


class ReportQuery(Schema):
    purpose: Literal["procurement", "pcb_fabrication", "pcb_population", "consumables"] = (
        "procurement"
    )
    as_of: date | None = None
    max_age_days: int | None = Field(default=None, ge=0, le=3650)


@router.get("/revisions/{revision_id}")
def revision_report(request, revision_id: UUID, params: Query[ReportQuery]):
    return report(request.user, revision_id, **params.dict())
