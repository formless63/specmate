from uuid import UUID

from pydantic import Field

from specmate.assemblies.contracts import StrictModel


class ListShares(StrictModel):
    workspace_id: UUID
    offset: int = Field(default=0, ge=0, le=100_000)
    limit: int = Field(default=50, ge=1, le=100)
