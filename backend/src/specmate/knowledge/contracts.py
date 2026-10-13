from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.facts.contracts import SourcePath, Target


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


Kind = Literal["note", "decision", "attachment"]
DecisionStatus = Literal["proposed", "accepted", "rejected", "superseded"]


class AttachmentRef(StrictModel):
    """An exact registered source file. Its bytes, hash and rights stay with the source."""

    bundle_revision_id: UUID
    path: SourcePath
    label: str = Field(default="", max_length=200)


class Content(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=20000)
    decision_status: DecisionStatus | None = None
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=20)

    def check_kind(self, kind: str):
        if not self.title.strip():
            raise ValueError("Title is required.")
        if (kind == "decision") != (self.decision_status is not None):
            raise ValueError("Only decisions, and every decision, state a decision status.")
        if kind == "attachment" and not self.attachments:
            raise ValueError("An attachment item references at least one registered file.")
        if kind == "note" and not self.body.strip() and not self.attachments:
            raise ValueError("A note needs text or an attachment.")
        seen = {(str(a.bundle_revision_id), a.path) for a in self.attachments}
        if len(seen) != len(self.attachments):
            raise ValueError("Each attachment file is referenced once.")


class CreateItem(StrictModel):
    project_id: UUID
    kind: Kind
    content: Content
    links: list[Target] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def coherent(self):
        self.content.check_kind(self.kind)
        return self


class ReviseItem(StrictModel):
    item_id: UUID
    content: Content


class LinkItem(StrictModel):
    item_id: UUID
    target: Target


class UnlinkItem(StrictModel):
    link_id: UUID
    reason: str = Field(default="", max_length=1000)


class ReadItem(StrictModel):
    item_id: UUID


class ItemsForTarget(StrictModel):
    target: Target
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class ProjectItems(StrictModel):
    project_id: UUID
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)
