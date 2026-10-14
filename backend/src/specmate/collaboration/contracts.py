from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from specmate.assemblies.contracts import Path
from specmate.assemblies.contracts import StrictModel as BaseStrictModel
from specmate.catalog_matching.contracts import EvidenceInput


class StrictModel(BaseStrictModel):
    @field_validator("*", mode="after")
    @classmethod
    def safe_text(cls, value):
        values = value if isinstance(value, list) else [value]
        for text in values:
            if isinstance(text, str):
                if "\x00" in text:
                    raise ValueError("Text cannot contain null characters.")
                try:
                    text.encode("utf-8")
                except UnicodeEncodeError:
                    raise ValueError("Text must be valid Unicode.") from None
        return value


class CompareRevisions(StrictModel):
    old_revision_id: UUID
    candidate_revision_id: UUID
    changes_offset: int = Field(default=0, ge=0)
    changes_limit: int = Field(default=100, ge=1, le=200)
    parents_after: UUID | None = None
    parents_limit: int = Field(default=25, ge=1, le=100)
    parents_side: Literal["old", "candidate"] = "old"


class KnowledgePin(StrictModel):
    item_id: UUID
    entry_number: int = Field(ge=1)


class CreateReview(StrictModel):
    project_id: UUID
    old_revision_id: UUID
    candidate_revision_id: UUID
    title: str = Field(min_length=1, max_length=200)
    basis: str = Field(min_length=1, max_length=4000)
    recipients: list[str] = Field(default_factory=list, max_length=50)
    knowledge: KnowledgePin | None = None

    @model_validator(mode="after")
    def text_and_recipients(self):
        if not self.title.strip() or not self.basis.strip():
            raise ValueError("Title and basis are required.")
        if len(self.recipients) != len(set(self.recipients)) or any(
            not name.strip() or len(name) > 150 for name in self.recipients
        ):
            raise ValueError("Recipients must be unique explicit project members.")
        return self


class ReadReview(StrictModel):
    review_id: UUID


ReviewAction = Literal["comment", "recommend", "request_changes", "decline", "close", "reopen"]


class RespondReview(ReadReview):
    action: ReviewAction
    basis: str = Field(min_length=1, max_length=4000)
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def nonblank(self):
        if not self.basis.strip():
            raise ValueError("Review basis is required.")
        return self


class ProposeReviewUpgrade(ReadReview):
    owning_snapshot_id: UUID
    paths: list[Path] = Field(min_length=1, max_length=1000)
    basis: str = Field(min_length=1, max_length=4000)


class ReviewPage(StrictModel):
    project_id: UUID
    after: UUID | None = None
    limit: int = Field(default=25, ge=1, le=100)


class InboxPage(ReviewPage):
    unread_only: bool = False


class ReadNotification(StrictModel):
    notification_id: UUID
