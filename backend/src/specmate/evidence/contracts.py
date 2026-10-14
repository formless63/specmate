from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.evidence.taxonomy import Kind
from specmate.firmware_impact.contracts import CompareImpact

Source = Literal[
    "facts",
    "builds",
    "cable_test_plan",
    "physical_units",
    "interface_assessment",
    "firmware_impact",
    "subject_tests",
]
RecordedSource = Literal["interface_assessment", "firmware_impact"]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Note = Annotated[str, Field(max_length=2000)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ListEvidence(StrictModel):
    workspace_id: UUID
    kinds: list[Kind] | None = Field(default=None, max_length=8)
    subject_id: UUID | None = None
    # An actual physical unit or work batch: lists only the test records made on it.
    actual_id: UUID | None = None
    offset: int = Field(default=0, ge=0, le=10000)
    limit: int = Field(default=50, ge=1, le=100)

    @model_validator(mode="after")
    def distinct_kinds(self):
        if self.kinds is not None and len(set(self.kinds)) != len(self.kinds):
            raise ValueError("Evidence kinds must be distinct.")
        if self.subject_id is not None and self.actual_id is not None:
            raise ValueError("Filter by a fact subject or an actual subject, not both.")
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
        "recorded_result",
        "test_record",
    ]
    references: list[str] = Field(default_factory=list)
    independently_verified: bool = False


class EvidenceItem(StrictModel):
    evidence_id: str
    kind: Kind
    kind_label: str
    source: Source
    workspace_id: UUID
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
    # Recorded results only: True when a pinned input has a newer revision. None elsewhere.
    stale: bool | None = None
    physical_qualification: Literal[False] = False


class EvidenceList(StrictModel):
    workspace_id: UUID
    items: list[EvidenceItem]
    offset: int
    limit: int
    has_more: bool
    scan_limit_reached: bool = False


class RecordInterfaceAssessment(StrictModel):
    """Record the current separated result of one exact frozen interface assessment."""

    revision_id: UUID
    note: Note = ""


class RecordFirmwareImpact(StrictModel):
    """Record one exact firmware impact comparison as it was shown."""

    comparison: CompareImpact
    # The comparison hash the reviewer saw; a different current result is a conflict.
    expected_comparison_sha256: Sha256 | None = None
    note: Note = ""


class ReadRecordedResult(StrictModel):
    record_id: UUID


class RecordedPinState(StrictModel):
    role: str
    revision_id: UUID
    definition_id: UUID
    number: int
    latest_number: int
    newer_revision_exists: bool


class RecordedResult(StrictModel):
    record_id: UUID
    workspace_id: UUID
    source: RecordedSource
    kind: Kind
    algorithm_version: str
    request: dict
    result: dict
    result_sha256: Sha256
    note: str
    recorded_at: str
    recorded_by_id: int
    pins: list[RecordedPinState]
    stale: bool
    # Firmware impact records: fact assertions arrived in the compared scope after recording.
    # None for records with no assertion scope.
    newer_assertions: bool | None = None
    rewritten: Literal[False] = False
    physical_qualification: Literal[False] = False


class ReadApplicability(StrictModel):
    """Evidence about a revision's definition, read against one exact selected revision."""

    workspace_id: UUID
    revision_id: UUID
    offset: int = Field(default=0, ge=0, le=10000)
    limit: int = Field(default=50, ge=1, le=100)


ApplicabilityStatus = Literal[
    "exact_revision",
    "exact_unit_only",
    "definition_scope_unverified",
    "stale_earlier_revision",
    "inapplicable_later_revision",
]


class DesignChange(StrictModel):
    """What differs between the evidence's revision and the selected revision."""

    from_number: int
    to_number: int
    content_changed: bool
    changed_sections: list[str]
    sections_truncated: bool = False


class Applicability(StrictModel):
    status: ApplicabilityStatus
    reason: str
    # The revision the evidence is attached to; None for a definition-wide subject.
    evidence_revision_id: UUID | None = None
    evidence_revision_number: int | None = None
    change: DesignChange | None = None
    observation_preserved: Literal[True] = True
    qualifies_selected_revision: Literal[False] = False


class ApplicabilityItem(StrictModel):
    item: EvidenceItem
    applicability: Applicability


class RevisionRef(StrictModel):
    revision_id: UUID
    definition_id: UUID
    number: int
    latest_number: int
    is_latest: bool


class ApplicabilityList(StrictModel):
    workspace_id: UUID
    revision: RevisionRef
    items: list[ApplicabilityItem]
    offset: int
    limit: int
    has_more: bool
    scan_limit_reached: bool = False
    historical_results_modified: Literal[False] = False
