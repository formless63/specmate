from decimal import Context, Decimal, InvalidOperation, localcontext
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

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
QUANTITY_CONTEXT = Context(prec=40, Emin=-40, Emax=40)


def exact_amount(value):
    """Bound lexical precision before Pydantic or decimal contexts can round an input."""
    if isinstance(value, bool | float) or not isinstance(value, str | int | Decimal):
        raise ValueError("Quantity amounts require decimal strings or exact integers.")
    if isinstance(value, str) and len(value) > 100:
        raise ValueError("Quantity amount is too long.")
    if isinstance(value, int) and abs(value) > 999999999999999:
        raise ValueError("Quantity amount exceeds the supported range.")
    try:
        amount = value if isinstance(value, Decimal) else Decimal(value)
    except InvalidOperation:
        raise ValueError("Invalid decimal quantity.") from None
    if not amount.is_finite():
        raise ValueError("Quantity amount must be finite.")
    parts = amount.as_tuple()
    if len(parts.digits) > 24 or not -9 <= parts.exponent <= 14:
        raise ValueError("Quantity exponent or precision is outside the supported range.")
    if amount and not -9 <= amount.adjusted() <= 14:
        raise ValueError("Quantity amount is outside the supported range.")
    return amount


Amount = Annotated[Decimal, BeforeValidator(exact_amount, json_schema_input_type=str | int)]


def quantity_add(left, right):
    with localcontext(QUANTITY_CONTEXT):
        return left + right


def quantity_subtract(left, right):
    with localcontext(QUANTITY_CONTEXT):
        return left - right


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Quantity(Payload):
    amount: Amount = Field(
        max_digits=24,
        decimal_places=9,
        allow_inf_nan=False,
        description="Use exact decimal strings or integers; floating-point amounts are rejected.",
    )
    unit: Unit

    @model_validator(mode="after")
    def check_representable(self):
        if self.unit == "ea" and self.amount != self.amount.to_integral_value():
            raise ValueError("Count quantities must be whole items.")
        canonical = self.canonical
        with localcontext(QUANTITY_CONTEXT):
            if canonical.copy_abs() > MAX_QUANTITY or canonical != canonical.quantize(QUANTUM):
                raise ValueError("Canonical quantity exceeds the supported range or precision.")
        return self

    @property
    def canonical(self):
        with localcontext(QUANTITY_CONTEXT):
            return self.amount * UNITS[self.unit][1]

    @property
    def dimension(self):
        return UNITS[self.unit][0]


class CreateLocation(Payload):
    workspace_id: UUID | None = None
    # TRANSITIONAL (workspace collections): a project id only selects its workspace; the
    # location is a workspace record. P3 removes it.
    project_id: UUID | None = None
    name: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def one_scope(self):
        if (self.workspace_id is None) == (self.project_id is None):
            raise ValueError("Provide exactly one of workspace_id or project_id.")
        return self

    @property
    def scope_id(self) -> UUID:
        return self.workspace_id or self.project_id


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
    # Optional project context: navigation and filtering only, never an owner or authority.
    project_id: UUID | None = None


class Release(Payload):
    reservation_id: UUID
    reason: str = Field(min_length=1, max_length=4000)


class ListInventory(Payload):
    workspace_id: UUID
    # Optional filter: only reservations and work batches carrying this project context.
    project_id: UUID | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class AccountResult(BaseModel):
    account_id: UUID
    workspace_id: UUID
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
    project_id: UUID | None
    consumed_quantity: str
    remaining_quantity: str
    status: Literal["active", "released", "consumed"]
    actor_id: int
    request_id: str
    created_at: str


class CreateWorkBatch(Payload):
    revision_id: UUID
    kind: Literal["job", "batch"] = "batch"
    label: str = Field(min_length=1, max_length=200)
    planned_units: int | None = Field(default=None, ge=1, le=1_000_000, strict=True)
    # Optional project context: navigation and filtering only, never an owner or authority.
    project_id: UUID | None = None


class RecordWorkCompletion(Assertion):
    work_batch_id: UUID
    units_completed: int = Field(ge=1, le=1_000_000, strict=True)


class Consume(Assertion):
    reservation_id: UUID
    work_batch_id: UUID
    physical_unit_id: UUID | None = None
    quantity: Quantity
    remainder: Literal["retain", "release"]
    expected_work_state: UUID


class ReturnUnused(Assertion):
    consumption_id: UUID
    quantity: Quantity
    expected_work_state: UUID


class WorkBatchResult(BaseModel):
    work_batch_id: UUID
    workspace_id: UUID
    revision_id: UUID
    definition_id: UUID
    kind: Literal["job", "batch"]
    label: str
    planned_units: int | None
    project_id: UUID | None
    reported_completed_units: int
    progress: Literal["none_reported", "partial", "reported_complete"]
    state: str
    actual_unit_tracking: Literal["separate_records"] = "separate_records"
    physical_qualification: Literal[False] = False
