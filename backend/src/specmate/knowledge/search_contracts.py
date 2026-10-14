"""Live knowledge search and exact attachment inspection inputs."""

from uuid import UUID

from pydantic import Field, field_validator

from specmate.catalog.discovery import SearchCatalog
from specmate.facts.contracts import SourcePath, Target
from specmate.knowledge.contracts import Kind, StrictModel


class SearchKnowledge(StrictModel):
    query: str = Field(min_length=1, max_length=200)
    project_id: UUID | None = None
    kind: Kind | None = None
    target: Target | None = None
    include_history: bool = False
    after: UUID | None = None
    limit: int = Field(default=25, ge=1, le=50)

    @field_validator("query")
    @classmethod
    def valid_query(cls, value):
        value = SearchCatalog.unicode_query(value.strip())
        if not value:
            raise ValueError("Search text is required.")
        return value


class PreviewAttachment(StrictModel):
    item_id: UUID
    entry_id: UUID
    bundle_revision_id: UUID
    path: SourcePath
