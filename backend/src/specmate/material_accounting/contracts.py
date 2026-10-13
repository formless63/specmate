"""Exact preparation accounting; plans and observations never issue stock."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.bom.contracts import DemandQuantity, WasteAllowance
from specmate.end_preparation.contracts import ApplyProfile
from specmate.interfaces.contracts import Text, unique
from specmate.inventory.contracts import Amount, Quantity
from specmate.workshop_profiles.schemas import Source


class Extent(StrictModel):
    amount_mm: Amount | None = None
    basis: Text
    source: Source | None = None

    @model_validator(mode="after")
    def nonnegative(self):
        if self.amount_mm is not None:
            Quantity(amount=self.amount_mm, unit="mm")
            if self.amount_mm < 0:
                raise ValueError("Material extents must be nonnegative.")
        return self


class Reconciliation(StrictModel):
    # Entire batch observations. Never multiplied by planned quantity.
    consumption_ids: list[UUID] = Field(default_factory=list, max_length=128)
    retained: DemandQuantity
    waste: DemandQuantity
    basis: Text
    source: Source | None = None

    @model_validator(mode="after")
    def coherent(self):
        unique(self.consumption_ids)
        if self.retained.unit != self.waste.unit:
            raise ValueError("Reconciliation extents must use the same declared unit.")
        return self


class Piece(StrictModel):
    section_id: LocalId | None = None
    installed: Extent
    cut_basis: Literal["declaration", "preparation_suggestion"] = "declaration"
    profile_revision_id: UUID | None = None
    extra_waste: Extent
    reconciliation: Reconciliation | None = None

    @model_validator(mode="after")
    def selected_recipe(self):
        if self.cut_basis == "preparation_suggestion" and self.profile_revision_id is None:
            raise ValueError("Selecting a preparation suggestion requires an exact profile.")
        return self


class Consumable(StrictModel):
    local_id: LocalId
    revision_id: UUID
    quantity: DemandQuantity
    waste: WasteAllowance | None = None
    basis: Text
    source: Source | None = None
    reconciliation: Reconciliation | None = None


class MaterialPlan(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    subject_revision_id: UUID
    quantity: int | None = Field(default=1, ge=1, le=1000000, strict=True)
    decision: Literal["make", "buy", "unknown"] = "unknown"
    decision_basis: Text
    pieces: list[Piece] = Field(default_factory=list, max_length=256)
    consumables: list[Consumable] = Field(default_factory=list, max_length=256)
    end_preparation: ApplyProfile | None = None

    @model_validator(mode="after")
    def unique_claims(self):
        unique([p.section_id for p in self.pieces])
        unique([c.local_id for c in self.consumables])
        # An event cannot be attributed twice to two materials in the same sheet.
        unique(
            [
                cid
                for row in [*self.pieces, *self.consumables]
                if row.reconciliation
                for cid in row.reconciliation.consumption_ids
            ]
        )
        return self


class CreatePlan(StrictModel):
    project_id: UUID
    name: Text
    plan: MaterialPlan


class UpdatePlan(StrictModel):
    draft_id: UUID
    plan: MaterialPlan


class CapturePlan(StrictModel):
    draft_id: UUID


class ReadPlan(StrictModel):
    revision_id: UUID
