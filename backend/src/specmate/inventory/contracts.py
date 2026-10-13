from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Dimension = Literal["count", "length", "mass"]
Unit = Literal["ea", "m", "cm", "mm", "kg", "g"]
Status = Literal["declared", "observed", "measured"]
UNITS = {
    "ea": ("count", Decimal(1)),
    "m": ("length", Decimal(1)),
    "cm": ("length", Decimal("0.01")),
    "mm": ("length", Decimal("0.001")),
    "kg": ("mass", Decimal(1)),
    "g": ("mass", Decimal("0.001")),
}
CANONICAL_UNITS = {"count": "ea", "length": "m", "mass": "kg"}
MAX_QUANTITY = Decimal("999999999999999.999999999")
QUANTUM = Decimal("0.000000001")


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Quantity(Payload):
    amount: Decimal = Field(max_digits=24, decimal_places=9, allow_inf_nan=False)
    unit: Unit

    @model_validator(mode="after")
    def check_representable(self):
        if self.unit == "ea" and self.amount != self.amount.to_integral_value():
            raise ValueError("Count quantities must be whole items.")
        canonical = self.canonical
        if abs(canonical) > MAX_QUANTITY or canonical != canonical.quantize(QUANTUM):
            raise ValueError("Canonical quantity exceeds the supported range or precision.")
        return self

    @property
    def canonical(self):
        return self.amount * UNITS[self.unit][1]

    @property
    def dimension(self):
        return UNITS[self.unit][0]


class CreateLocation(Payload):
    project_id: UUID
    name: str = Field(min_length=1, max_length=200)


class Assertion(Payload):
    reason: str = Field(min_length=1, max_length=4000)
    assertion_source: str = Field(min_length=1, max_length=1000)
    assertion_status: Status = "declared"


class OpenStock(Assertion):
    lot_id: UUID
    location_id: UUID
    dimension: Dimension
    quantity: Quantity | None = None


class ChangeStock(Assertion):
    account_id: UUID
    quantity: Quantity


class Reserve(Payload):
    account_id: UUID
    quantity: Quantity
    purpose: str = Field(min_length=1, max_length=4000)


class Release(Payload):
    reservation_id: UUID
    reason: str = Field(min_length=1, max_length=4000)


class ListInventory(Payload):
    project_id: UUID
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class AccountResult(BaseModel):
    account_id: UUID
    project_id: UUID
    lot_id: UUID
    lot_label: str
    revision_id: UUID
    definition_id: UUID
    location_id: UUID
    location_name: str
    dimension: Dimension
    unit: Unit
    quantity_status: Literal["known", "unknown"]
    physical_quantity: str | None
    reserved_quantity: str
    available_quantity: str | None
    state: str
    assertion_source: str
    assertion_status: Status


class ReservationResult(BaseModel):
    reservation_id: UUID
    account_id: UUID
    quantity: str
    amount: str
    unit: Unit
    purpose: str
    status: Literal["active", "released"]
    actor_id: int
    request_id: str
    created_at: str
