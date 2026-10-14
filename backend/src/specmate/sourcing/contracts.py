"""Typed sourcing payloads. Price, currency and freshness are optional and never defaulted."""

import re
from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from specmate.inventory.contracts import Amount, Unit

Availability = Literal["in_stock", "limited", "unavailable", "unknown"]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Price(Payload):
    # Price for ONE ``per_unit``. Either field may be unknown independently.
    amount: Amount | None = None
    currency: str | None = None
    per_unit: Unit = "ea"

    @field_validator("currency")
    @classmethod
    def iso_code(cls, value):
        if value is not None and not re.fullmatch(r"[A-Z]{3}", value):
            raise ValueError("Currency must be a three-letter uppercase code.")
        return value

    @model_validator(mode="after")
    def nonnegative(self):
        if self.amount is not None and self.amount < 0:
            raise ValueError("A price cannot be negative.")
        return self


class RecordOffer(Payload):
    workspace_id: UUID
    revision_id: UUID
    supplier: str = Field(min_length=1, max_length=200)
    supplier_ref: str = Field(default="", max_length=200)
    source: str = Field(min_length=1, max_length=1000)
    review_basis: str = Field(min_length=1, max_length=4000)
    offered_on: date
    valid_until: date | None = None
    price: Price | None = None
    availability: Availability = "unknown"
    lead_time_days: int | None = Field(default=None, ge=0, le=3650, strict=True)
    substitute_for_revision_id: UUID | None = None
    substitution_basis: str = Field(default="", max_length=4000)
    supersedes_offer_id: UUID | None = None

    @model_validator(mode="after")
    def coherent(self):
        if self.valid_until is not None and self.valid_until < self.offered_on:
            raise ValueError("An offer cannot expire before it was made.")
        if self.substitute_for_revision_id is not None:
            if not self.substitution_basis.strip():
                raise ValueError("A substitute offer requires an explicit substitution basis.")
            if self.substitute_for_revision_id == self.revision_id:
                raise ValueError("A substitute must differ from the revision it replaces.")
        elif self.substitution_basis.strip():
            raise ValueError("A substitution basis requires the replaced revision.")
        return self


class SourcingReadRequest(Payload):
    # A frozen bom_plan or material_plan revision.
    revision_id: UUID
    purpose: Literal["procurement", "pcb_fabrication", "pcb_population", "consumables"] = (
        "procurement"
    )
    as_of: date | None = None
    # Optional freshness policy; without it (and without valid_until) freshness is unknown.
    max_age_days: int | None = Field(default=None, ge=0, le=3650, strict=True)


class OfferResult(BaseModel):
    offer_id: UUID
    workspace_id: UUID
    revision_id: UUID
    supplier: str
    supplier_ref: str
    source: str
    review_basis: str
    reviewed_by: dict
    offered_on: str
    valid_until: str | None
    price: dict | None
    availability: Availability
    lead_time_days: int | None
    substitution: dict | None
    supersedes_offer_id: UUID | None
    superseded_by_offer_id: UUID | None
    created_at: str
