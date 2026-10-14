from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.evidence.taxonomy import Kind

Source = Literal["facts", "builds", "cable_test_plan", "physical_units"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ListEvidence(StrictModel):
    project_id: UUID
    kinds: list[Kind] | None = Field(default=None, max_length=8)
    subject_id: UUID | None = None
    offset: int = Field(default=0, ge=0, le=10000)
    limit: int = Field(default=50, ge=1, le=100)

    @model_validator(mode="after")
    def distinct_kinds(self):
        if self.kinds is not None and len(set(self.kinds)) != len(self.kinds):
            raise ValueError("Evidence kinds must be distinct.")
        return self


class ReadTaxonomy(StrictModel):
    pass


class KindDescription(StrictModel):
    kind: Kind
    label: str
    subject_scope: Literal["design", "actual", "either"]
    summary: str
    establishes: list[str]
    does_not_establish: list[str]
    fact_methods: list[str]


class Taxonomy(StrictModel):
    kinds: list[KindDescription]


class SubjectRef(StrictModel):
    scope: Literal["design", "actual", "project"]
    kind: str
    id: UUID
    label: str


class MethodDetail(StrictModel):
    name: str
    procedure: str | None = None
    instrument: str | None = None
    formula: str | None = None
    algorithm_version: str | None = None
    tool: str | None = None


class Basis(StrictModel):
    origin: Literal[
        "manual_entry",
        "registered_source",
        "assertion_inputs",
        "human_review",
        "instrument_record",
        "tool_receipt",
        "plan_declaration",
        "unit_declaration",
        "declared_preference",
    ]
    references: list[str] = Field(default_factory=list)
    independently_verified: bool = False


class EvidenceItem(StrictModel):
    evidence_id: str
    kind: Kind
    kind_label: str
    source: Source
    project_id: UUID
    subject: SubjectRef
    statement: str
    status: str
    conditions: list[dict] = Field(default_factory=list)
    method: MethodDetail
    basis: Basis
    recorded_at: str
    observed_at: str | None = None
    actor_id: int | None = None
    establishes: list[str]
    does_not_establish: list[str]
    warnings: list[str] = Field(default_factory=list)
    physical_qualification: Literal[False] = False


class EvidenceList(StrictModel):
    project_id: UUID
    items: list[EvidenceItem]
    offset: int
    limit: int
    has_more: bool
    scan_limit_reached: bool = False
