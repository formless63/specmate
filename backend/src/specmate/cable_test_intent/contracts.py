"""Authored bench expectations are independent of performed physical tests."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints, model_validator

from specmate.assemblies.contracts import LocalId, Path, StrictModel
from specmate.cables.contracts import ElementPath
from specmate.catalog_matching.contracts import EvidenceInput
from specmate.interfaces.contracts import ContactId, Text, unique

Declaration = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class Terminal(StrictModel):
    endpoint_id: LocalId
    kind: Literal["contact", "stock_feature"]
    contact_id: ContactId | None = None
    element_path: ElementPath | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.kind == "contact":
            if self.contact_id is None or self.element_path is not None:
                raise ValueError("Contact terminal requires only an exact contact ID.")
        elif self.element_path is None or self.contact_id is not None:
            raise ValueError("Stock terminal requires only an exact conductive feature path.")
        return self

    def key(self):
        return self.endpoint_id, self.kind, self.contact_id or self.element_path


class PairExpectation(StrictModel):
    local_id: LocalId
    first: Terminal
    second: Terminal
    intent: Literal["continuity", "isolation", "unknown"] = "unknown"
    basis: Declaration
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def distinct(self):
        if self.first.key() == self.second.key():
            raise ValueError("A test pair requires distinct terminals.")
        return self


class Label(StrictModel):
    local_id: LocalId
    text: Annotated[str, Field(min_length=1, max_length=500)]
    endpoint_id: LocalId | None = None
    terminal: Terminal | None = None
    basis: Declaration
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def consistent(self):
        if not self.text.strip():
            raise ValueError("A label requires nonblank authored text.")
        if self.endpoint_id is not None and self.terminal is not None:
            raise ValueError("A label targets the cable, one endpoint or one terminal.")
        return self


class TestPlan(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    root_revision_id: UUID
    occurrence_path: Path = Field(default_factory=list)
    cable_revision_id: UUID
    pairs: list[PairExpectation] = Field(default_factory=list, max_length=2048)
    labels: list[Label] = Field(default_factory=list, max_length=2048)

    @model_validator(mode="after")
    def unique_ids(self):
        unique([p.local_id for p in self.pairs])
        unique([tuple(sorted([p.first.key(), p.second.key()])) for p in self.pairs])
        unique([label.local_id for label in self.labels])
        return self


class CreatePlan(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
    name: Text
    test_plan: TestPlan


class UpdatePlan(StrictModel):
    draft_id: UUID
    test_plan: TestPlan


class CapturePlan(StrictModel):
    draft_id: UUID


class ReadPlan(StrictModel):
    revision_id: UUID


class InspectTarget(StrictModel):
    root_revision_id: UUID
    occurrence_path: Path = Field(default_factory=list)
    cable_revision_id: UUID
