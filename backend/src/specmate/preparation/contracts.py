"""Reviewed arithmetic recipes, separate from illustrative workshop practices."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.cables.contracts import ElementPath
from specmate.interfaces.contracts import Text, unique
from specmate.inventory.contracts import Amount, Quantity
from specmate.workshop_profiles.schemas import Source


class Allowance(StrictModel):
    local_id: LocalId
    kind: Literal["slack", "preparation", "trim"]
    scope: Literal["whole_piece", "end_a", "end_b"]
    amount_mm: Amount | None = None
    basis: Text
    source: Source | None = None

    @model_validator(mode="after")
    def exact_nonnegative(self):
        if self.amount_mm is not None:
            if self.amount_mm < 0:
                raise ValueError("Allowances must be nonnegative; trim explicitly subtracts.")
            Quantity(amount=self.amount_mm, unit="mm")
        return self


class Formula(StrictModel):
    local_id: LocalId
    label: Text
    target: Literal["stock_piece", "conductive_feature"]
    element_path: ElementPath | None = None
    input_length: Literal["route", "finished", "stock_cut", "conductor_cut"]
    input_basis: Literal["declaration", "model_suggestion"]
    allowances: list[Allowance] = Field(default_factory=list, max_length=32)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def coherent(self):
        unique([a.local_id for a in self.allowances])
        if (self.target == "conductive_feature") != (self.element_path is not None):
            raise ValueError("Conductive formulas require an exact feature path only.")
        if self.input_length == "conductor_cut" and self.element_path is None:
            raise ValueError("Conductor input requires a conductive-feature target.")
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed formulas require a review basis.")
        return self


class PreparationProfile(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    stock_revision_id: UUID
    formulas: list[Formula] = Field(default_factory=list, max_length=128)

    @model_validator(mode="after")
    def unique_targets(self):
        unique([f.local_id for f in self.formulas])
        unique([(f.target, f.element_path) for f in self.formulas])
        return self


class CreateProfile(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
    name: Text
    profile: PreparationProfile


class UpdateProfile(StrictModel):
    draft_id: UUID
    profile: PreparationProfile


class CaptureProfile(StrictModel):
    draft_id: UUID


class ReadProfile(StrictModel):
    revision_id: UUID


class Application(StrictModel):
    # Cable owns one stock piece (null); harness sections retain their own stable IDs.
    section_id: LocalId | None = None
    profile_revision_id: UUID


class ComputeCuts(StrictModel):
    revision_id: UUID
    applications: list[Application] = Field(min_length=1, max_length=256)
    quantity: int | None = Field(default=1, ge=1, le=1000000, strict=True)

    @model_validator(mode="after")
    def once_per_piece(self):
        unique([a.section_id for a in self.applications])
        return self
