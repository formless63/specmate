"""History reports retained evidence and explicitly separate current observations."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel


class HistoryQuery(StrictModel):
    workspace_id: UUID
    definition_id: UUID | None = None
    actor_id: int | None = Field(default=None, ge=1, le=9223372036854775807)
    kind: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_]{0,49}$")
    source: Literal["retained", "receipts", "revisions", "current_drafts"] = "retained"
    from_date: datetime | None = None
    to_date: datetime | None = None
    limit: int = Field(default=25, ge=1, le=50)
    after: str | None = Field(default=None, max_length=3000)

    @model_validator(mode="after")
    def dates(self):
        for date in (self.from_date, self.to_date):
            if date is not None and date.tzinfo is None:
                raise ValueError("History dates must include a timezone.")
        if self.from_date and self.to_date and self.from_date > self.to_date:
            raise ValueError("History start must not follow its end.")
        return self
