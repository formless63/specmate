"""Reviewed per-end engineering intent; no display defaults or physical assertions."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.cables.contracts import ElementPath
from specmate.interfaces.contracts import ContactId, Text, unique
from specmate.inventory.contracts import Amount, Quantity
from specmate.workshop_profiles.schemas import Source


class Dimension(StrictModel):
    nominal_mm: Amount | None = None
    minus_mm: Amount | None = None
    plus_mm: Amount | None = None
    datum: Literal["unknown", "from_stock_cut_end", "along_finished_lead"] = "unknown"
    basis: Text | None = None

    @model_validator(mode="after")
    def coherent(self):
        values = [self.nominal_mm, self.minus_mm, self.plus_mm]
        for value in values:
            if value is not None:
                if value < 0:
                    raise ValueError("Preparation dimensions and tolerances must be nonnegative.")
                Quantity(amount=value, unit="mm")
        if any(v is not None for v in values) and (not self.basis or self.datum == "unknown"):
            raise ValueError("Known dimensions require an explicit datum and basis.")
        if self.nominal_mm is not None and self.minus_mm is not None:
            if self.minus_mm > self.nominal_mm:
                raise ValueError("Lower tolerance cannot extend below zero.")
        return self


class FeatureTarget(StrictModel):
    kind: Literal["stock_feature"] = "stock_feature"
    element_path: ElementPath


class ContactTarget(StrictModel):
    kind: Literal["endpoint_contact"] = "endpoint_contact"
    body_revision_id: UUID
    contact_id: ContactId


BondTarget = Annotated[FeatureTarget | ContactTarget, Field(discriminator="kind")]


class InstructionBase(StrictModel):
    local_id: LocalId
    element_path: ElementPath
    basis: Text | None = None
    source: Source | None = None


class LayerStrip(InstructionBase):
    kind: Literal["layer_strip"] = "layer_strip"
    treatment: Literal["unknown", "retain", "remove", "strip_back"] = "unknown"
    length: Dimension = Field(default_factory=Dimension)


class DrainTreatment(InstructionBase):
    kind: Literal["drain_treatment"] = "drain_treatment"
    treatment: Literal["unknown", "retain", "trim", "insulate", "prepare_termination"] = "unknown"
    length: Dimension = Field(default_factory=Dimension)


class ShieldLead(InstructionBase):
    kind: Literal["shield_lead"] = "shield_lead"
    treatment: Literal["unknown", "retain_shield", "trim", "form_lead", "fold_back"] = "unknown"
    length: Dimension = Field(default_factory=Dimension)


class BondExpectation(InstructionBase):
    kind: Literal["bond_expectation"] = "bond_expectation"
    treatment: Literal["unknown", "isolate", "bond"] = "unknown"
    target: BondTarget | None = None

    @model_validator(mode="after")
    def target_only_for_bond(self):
        if self.treatment != "bond" and self.target is not None:
            raise ValueError("Only an expected bond may specify a target.")
        if isinstance(self.target, FeatureTarget) and self.target.element_path == self.element_path:
            raise ValueError("A bond target must be a distinct feature.")
        return self


Instruction = Annotated[
    LayerStrip | DrainTreatment | ShieldLead | BondExpectation, Field(discriminator="kind")
]


class End(StrictModel):
    instructions: list[Instruction] = Field(default_factory=list, max_length=512)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def coherent(self):
        unique([i.local_id for i in self.instructions])
        unique([(i.kind, i.element_path) for i in self.instructions])
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed ends require a review basis.")
        if any(i.treatment != "unknown" and not i.basis for i in self.instructions):
            raise ValueError("Known treatments require an explicit basis.")
        return self


class EndPreparationProfile(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    stock_revision_id: UUID
    a: End = Field(default_factory=End)
    b: End = Field(default_factory=End)


class CreateProfile(StrictModel):
    project_id: UUID
    name: Text
    profile: EndPreparationProfile


class UpdateProfile(StrictModel):
    draft_id: UUID
    profile: EndPreparationProfile


class CaptureProfile(StrictModel):
    draft_id: UUID


class ReadProfile(StrictModel):
    revision_id: UUID


class ApplyProfile(StrictModel):
    cable_revision_id: UUID
    profile_revision_id: UUID
    a_endpoint_id: LocalId
    b_endpoint_id: LocalId
    mapping_basis: Text
    mapping_review: Literal["unreviewed", "reviewed"] = "unreviewed"
