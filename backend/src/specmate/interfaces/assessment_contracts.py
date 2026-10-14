"""Separated declaration checks; none constitutes physical qualification."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.catalog_matching.contracts import EvidenceInput, EvidenceResult
from specmate.contracts import FiniteNumber
from specmate.interfaces.condition_contracts import TemperatureEnvelope

Text = Annotated[str, Field(min_length=1, max_length=2000)]
ContactId = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S+$")]
Dimension = Literal[
    "mating",
    "pin_correspondence",
    "polarity",
    "levels",
    "current",
    "protocol",
    "shielding",
    "grounding",
    "fit",
]


class Declaration(StrictModel):
    status: Literal["unknown", "satisfied", "invalid"] = "unknown"
    basis: Text | None = None
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def justified(self):
        if self.status != "unknown" and not self.basis:
            raise ValueError("A declared assessment requires its basis.")
        return self


class OperatingConditions(StrictModel):
    """A proposed operating envelope, not a value inferred from component ratings."""

    voltage_min_v: FiniteNumber | None = None
    voltage_max_v: FiniteNumber | None = None
    temperature: TemperatureEnvelope | None = None
    mode: Text | None = None
    demand_a: FiniteNumber | None = Field(default=None, ge=0)
    required_protocol: Text | None = None
    condition: Text | None = None
    basis: Text | None = None
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def justified(self):
        if (self.voltage_min_v is None) != (self.voltage_max_v is None):
            raise ValueError("An operating voltage envelope needs both endpoints.")
        if self.voltage_min_v is not None and self.voltage_min_v > self.voltage_max_v:
            raise ValueError("Operating voltage range is reversed.")
        if any(
            v is not None
            for v in (
                self.voltage_min_v,
                self.demand_a,
                self.required_protocol,
                self.temperature,
                self.mode,
            )
        ):
            if not self.basis:
                raise ValueError("Declared operating inputs require a basis.")
        return self


class ContactPair(StrictModel):
    local_id: LocalId
    left_contact_id: ContactId
    right_contact_id: ContactId
    # Explicit expected signal identity, never inferred from drawing positions or labels.
    expected_signal: Text | None = None
    basis: Text
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)
    operating: OperatingConditions = Field(default_factory=OperatingConditions)


class BondIntent(StrictModel):
    left_contact_id: ContactId | None = None
    right_contact_id: ContactId | None = None
    required: Literal["unknown", "bonded", "isolated"] = "unknown"
    declared: Literal["unknown", "bonded", "isolated"] = "unknown"
    basis: Text | None = None
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def justified(self):
        if self.required != "unknown" or self.declared != "unknown":
            if not self.basis or not self.left_contact_id or not self.right_contact_id:
                raise ValueError("A bond/isolation intent requires exact contacts and a basis.")
        return self


class InterfaceAssessment(StrictModel):
    kind: Literal["interface_assessment"] = "interface_assessment"
    schema_version: Literal["0.1"] = "0.1"
    left_pinout_revision_id: UUID
    right_pinout_revision_id: UUID
    mating: Declaration = Field(default_factory=Declaration)
    fit: Declaration = Field(default_factory=Declaration)
    pairs: list[ContactPair] = Field(default_factory=list, max_length=1000)
    shielding: BondIntent = Field(default_factory=BondIntent)
    grounding: BondIntent = Field(default_factory=BondIntent)

    @model_validator(mode="after")
    def identities(self):
        if len({p.local_id for p in self.pairs}) != len(self.pairs):
            raise ValueError("Assessment row IDs must be unique.")
        return self


class Finding(StrictModel):
    dimension: Dimension
    pair_id: str | None = None
    # "flagged" is a review-level, non-blocking finding: allowed but needs human review.
    status: Literal["satisfied", "invalid", "unknown", "flagged"]
    basis: Literal["declaration", "comparison_of_declarations"]
    explanation: str
    evidence: list[EvidenceResult] = Field(default_factory=list)
    facts: dict = Field(default_factory=dict)


class AssessmentResult(StrictModel):
    left_pinout_revision_id: UUID
    right_pinout_revision_id: UUID
    findings: list[Finding]
    scope: Literal["exact_pinout_pair_and_explicit_contact_rows"] = (
        "exact_pinout_pair_and_explicit_contact_rows"
    )
    physical_qualification: Literal[False] = False
    limitations: list[str]
