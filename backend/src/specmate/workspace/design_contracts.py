"""Read-only Designs landing projection; review declarations are not check outcomes."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from specmate.workspace.contracts import LibraryRecord, Query, _clean_text


class ListDesigns(Query):
    workspace_id: UUID | None = None
    q: str = Field(default="", max_length=200)
    kind: Literal["cable", "harness", "assembly"] | None = None
    from_: str = Field(default="", alias="from", max_length=200)
    to: str = Field(default="", max_length=200)
    stock: str = Field(default="", max_length=200)
    board: str = Field(default="", max_length=200)
    status: Literal["draft", "draft_only", "frozen", "reviewed", "unreviewed", "unknown"] | None = (
        None
    )
    project_id: UUID | None = None
    after: str | None = Field(default=None, max_length=300)
    limit: int = Field(default=50, ge=1, le=100)

    @field_validator("q", "from_", "to", "stock", "board")
    @classmethod
    def clean_text(cls, value):
        return _clean_text(value)


class DesignEnd(BaseModel):
    label: str | None
    basis: Literal["intent_port", "intent_pinout", "endpoint_label", "unknown"]
    revision_id: UUID | None


class DesignPin(BaseModel):
    definition_id: UUID
    revision_id: UUID
    revision: int
    label: str


class DesignMetadata(BaseModel):
    basis: Literal["latest_frozen", "newest_draft", "unknown"]
    revision_id: UUID | None
    revision: int | None
    draft_id: UUID | None
    review: Literal["reviewed", "unreviewed", "unknown"]
    from_: DesignEnd = Field(alias="from")
    to: DesignEnd
    stocks: list[DesignPin]
    boards: list[DesignPin]
    checks: Literal["not_evaluated"] = "not_evaluated"


class DesignRecord(LibraryRecord):
    design: DesignMetadata


class DesignPage(BaseModel):
    workspace_id: UUID
    family: Literal["definition"] = "definition"
    project_id: UUID | None
    results: list[DesignRecord]
    next_after: str | None
