"""Reviewed release closure requests (EVD-004).

A release review is the coherent export request of one exact root plus the resolved
configurations it is released as and explicit rights decisions for its exact subjects.
"""

from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.contracts import SHA256
from specmate.export_packages.contracts import ExportRequest
from specmate.selected_packages.contracts import RightsReview


class ReleaseReview(ExportRequest):
    resolved_configuration_ids: list[UUID] = Field(default_factory=list, max_length=64)
    rights_reviews: list[RightsReview] = Field(default_factory=list, max_length=4000)

    @model_validator(mode="after")
    def unique_release_inputs(self):
        if len(set(self.resolved_configuration_ids)) != len(self.resolved_configuration_ids):
            raise ValueError("Include each resolved configuration once.")
        subjects = [r.subject for r in self.rights_reviews]
        if len(subjects) != len(set(subjects)):
            raise ValueError("Review each exact subject once.")
        return self


class Acknowledgement(StrictModel):
    """An explicit decision to release with the reviewed unresolved items still open."""

    reason: str = Field(min_length=1, max_length=4000)

    @model_validator(mode="after")
    def stated(self):
        if not self.reason.strip():
            raise ValueError("An acknowledgement needs a stated reason.")
        return self


class CreateRelease(ReleaseReview):
    name: str = Field(min_length=1, max_length=200)
    notes: str = Field(default="", max_length=4000)
    reviewed_sha256: str = Field(pattern=SHA256)
    acknowledgement: Acknowledgement | None = None
    # Navigation context only: the project then references the release.
    project_id: UUID | None = None

    @model_validator(mode="after")
    def named(self):
        if not self.name.strip():
            raise ValueError("A release needs a name.")
        return self


class ReleaseRef(StrictModel):
    release_id: UUID


class ListReleases(StrictModel):
    workspace_id: UUID
    project_id: UUID | None = None
    offset: int = Field(default=0, ge=0, le=100_000)
    limit: int = Field(default=50, ge=1, le=100)
