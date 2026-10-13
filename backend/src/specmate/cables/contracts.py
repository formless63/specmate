"""Exact cable selections and declared terminations; no implied electrical bonds."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.cables.lengths import LengthPlan
from specmate.interfaces.contracts import ContactId, Text, unique

ElementPath = Annotated[
    str, Field(min_length=1, max_length=1000, pattern=r"^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$")
]


class Endpoint(StrictModel):
    local_id: LocalId
    label: Text | None = None
    body_revision_id: UUID
    pinout_revision_id: UUID


class Termination(StrictModel):
    endpoint_id: LocalId
    element_path: ElementPath
    contact_id: ContactId
    basis: Text


class Cable(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    stock_revision_id: UUID
    lengths: LengthPlan | None = None
    endpoints: list[Endpoint] = Field(min_length=2, max_length=2)
    assignments: list[Termination] = Field(default_factory=list, max_length=2048)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def consistent(self):
        unique([e.local_id for e in self.endpoints])
        unique([(a.endpoint_id, a.element_path) for a in self.assignments])
        unique([(a.endpoint_id, a.contact_id) for a in self.assignments])
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed cable assignments require a basis.")
        return self


class CreateCable(StrictModel):
    project_id: UUID
    name: Text
    cable: Cable


class UpdateCable(StrictModel):
    draft_id: UUID
    cable: Cable


class CaptureCable(StrictModel):
    draft_id: UUID


class ReadCable(StrictModel):
    revision_id: UUID


class LengthImpact(StrictModel):
    before_revision_id: UUID
    after_revision_id: UUID
