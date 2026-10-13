"""A selected immutable boundary and explicit distribution declarations."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import Path, StrictModel
from specmate.contracts import SHA256


class RightsReview(StrictModel):
    subject: str = Field(min_length=1, max_length=650)
    decision: Literal["permitted", "withheld", "unknown"] = "unknown"
    basis: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def attributable(self):
        if self.decision != "unknown" and not self.basis.strip():
            raise ValueError("A rights decision requires an explicit review basis.")
        return self


class Selection(StrictModel):
    root_revision_id: UUID
    occurrence_path: Path = Field(default_factory=list)
    purpose: Literal["authorized_review", "distribution"] = "authorized_review"
    rights_reviews: list[RightsReview] = Field(default_factory=list, max_length=4000)

    @model_validator(mode="after")
    def unique_reviews(self):
        subjects = [r.subject for r in self.rights_reviews]
        if len(subjects) != len(set(subjects)):
            raise ValueError("Review each exact subject once.")
        return self


class Download(Selection):
    reviewed_sha256: str = Field(pattern=SHA256)
