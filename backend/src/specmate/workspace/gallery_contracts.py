"""Library home contracts: what needs attention, recent work, and card previews.

All of it is read-only and derived from records that already exist: recorded check
results, their pinned revisions, and the newest content of each definition. Nothing is
evaluated afresh here, so a card never claims more than the recorded evidence says.
Unknown stays unknown: an unrecorded check is not counted as passing.
"""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from specmate.workspace.contracts import KindCount, Query

AttentionKind = Literal[
    "failing_check", "unknown_check", "open_questions", "stale_evidence", "unknown_values"
]


class ReadLibraryHome(Query):
    """The Library home of one workspace: attention, the actor's recent work and kinds."""

    workspace_id: UUID | None = None
    limit: int = Field(default=12, ge=1, le=50, description="Items per row.")


class AttentionReason(BaseModel):
    kind: AttentionKind
    count: int = Field(ge=1)
    detail: str = Field(description="Plain words, for example '2 rows fail'.")


class HomeItem(BaseModel):
    record_id: UUID
    kind: str
    label: str
    created_at: datetime
    latest_revision: int | None = Field(description="Highest frozen revision; null if none.")
    latest_revision_id: UUID | None
    changed_at: datetime | None = Field(description="Latest draft change.")


class AttentionItem(HomeItem):
    status: Literal["fail", "unknown", "review"] = Field(
        description="The most severe reason: a failing recorded check, an unknown, or review."
    )
    reasons: list[AttentionReason] = Field(min_length=1)


class RecentItem(HomeItem):
    activity: Literal["edited", "frozen"]
    at: datetime


class AttentionTotals(BaseModel):
    failing_checks: int = Field(ge=0, description="Failing rows or findings in latest records.")
    unknown_checks: int = Field(ge=0, description="Unknown rows or findings in latest records.")
    open_questions: int = Field(ge=0, description="Open questions in intent drafts.")
    stale_evidence: int = Field(ge=0, description="Latest records with a newer pinned input.")
    unknown_values: int = Field(ge=0, description="Declared values recorded as unknown.")


class LibraryHome(BaseModel):
    workspace_id: UUID
    attention: list[AttentionItem] = Field(
        description="Failing recorded checks, open intent questions and stale records."
    )
    attention_total: int = Field(ge=0, description="Items needing attention, before the limit.")
    unknowns: list[AttentionItem] = Field(
        description="Items whose only reasons are unknown check rows or unknown declared values."
    )
    unknowns_total: int = Field(ge=0, description="Items with unknowns only, before the limit.")
    recent: list[RecentItem] = Field(description="The actor's own latest edits and freezes.")
    totals: AttentionTotals
    kinds: list[KindCount] = Field(description="Definitions in the workspace by kind.")
    definitions_total: int = Field(ge=0)
    scan_limit_reached: bool = Field(
        description="More records exist than were scanned; totals are then lower bounds."
    )


class ReadLibraryPreviews(Query):
    """Compact newest content of up to 50 definitions, for drawing gallery thumbnails."""

    workspace_id: UUID | None = None
    definition_ids: list[UUID] = Field(min_length=1, max_length=50)


class LibraryPreview(BaseModel):
    record_id: UUID
    kind: str
    source: Literal["revision", "draft", "none"] = Field(
        description="Latest frozen revision first; a never-frozen item shows its newest draft."
    )
    revision: int | None
    content: dict[str, Any] | None = Field(description="Null when absent or too large.")
    truncated: bool = Field(description="The content exceeded the preview size and is omitted.")
    stock: dict[str, Any] | None = Field(
        default=None, description="A cable's pinned wire stock construction, when readable."
    )
    body: dict[str, Any] | None = Field(
        default=None, description="A pinout's or port's pinned connector body interface."
    )
    pinout: dict[str, Any] | None = Field(
        default=None, description="A port's pinned pinout interface."
    )
    signal_types: dict[str, str] = Field(
        default_factory=dict,
        description="Signal types used by the pinout, keyed '<signal set revision>/<key>'.",
    )


class LibraryPreviews(BaseModel):
    workspace_id: UUID
    previews: list[LibraryPreview] = Field(description="Only definitions of this workspace.")
