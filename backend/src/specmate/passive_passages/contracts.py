"""Reviewed idealized passive declarations, separate from copper and physical facts."""

from decimal import Context, Decimal, InvalidOperation
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BeforeValidator, Field, StringConstraints, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.catalog_matching.contracts import EvidenceInput

ELECTRICAL_CONTEXT = Context(prec=80, Emin=-100, Emax=100)


def exact_number(value):
    if isinstance(value, bool | float) or not isinstance(value, str | int | Decimal):
        raise ValueError("Electrical values require exact decimal strings or integers.")
    if isinstance(value, str) and len(value) > 120:
        raise ValueError("Electrical decimal is too long.")
    if isinstance(value, int) and abs(value) > 10**30:
        raise ValueError("Electrical integer exceeds the supported range.")
    try:
        number = value if isinstance(value, Decimal) else Decimal(value)
    except InvalidOperation:
        raise ValueError("Invalid electrical decimal.") from None
    if not number.is_finite():
        raise ValueError("Electrical values must be finite.")
    parts = number.as_tuple()
    if len(parts.digits) > 40 or not -30 <= parts.exponent <= 30:
        raise ValueError("Electrical decimal precision or exponent exceeds the supported range.")
    if number and not -30 <= number.adjusted() <= 30:
        raise ValueError("Electrical value exceeds the supported range.")
    return number


ExactNumber = Annotated[Decimal, BeforeValidator(exact_number, json_schema_input_type=str | int)]
TerminalId = Annotated[str, Field(pattern=r"^terminal-[a-f0-9]{64}$")]
Basis = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class Passage(StrictModel):
    local_id: LocalId
    from_terminal_id: TerminalId
    to_terminal_id: TerminalId
    kind: Literal[
        "resistor",
        "capacitor",
        "diode",
        "inductor",
        "transformer",
        "conditional",
        "active",
        "unknown",
    ]
    resistance_ohm: ExactNumber | None = Field(default=None, ge=0)
    capacitance_f: ExactNumber | None = Field(default=None, gt=0)
    condition: str | None = Field(default=None, min_length=1, max_length=500)
    native_candidate_boundary_id: str | None = Field(default=None, min_length=1, max_length=80)
    basis: Basis
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def parameters(self):
        if self.from_terminal_id == self.to_terminal_id:
            raise ValueError("A passage requires distinct exact terminals.")
        if self.resistance_ohm is not None and self.kind != "resistor":
            raise ValueError("Only resistor models may declare resistance in this adapter.")
        if self.capacitance_f is not None and self.kind != "capacitor":
            raise ValueError("Only capacitor models may declare capacitance in this adapter.")
        return self


class PassageModel(StrictModel):
    schema_version: Literal["1"] = "1"
    root_revision_id: UUID
    assumptions: Literal["ideal_lumped_components"]
    model_basis: Basis
    passages: list[Passage] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def unique(self):
        ids = [p.local_id for p in self.passages]
        if len(set(ids)) != len(ids):
            raise ValueError("Passage IDs must be unique.")
        return self


class CreateModel(StrictModel):
    project_id: UUID
    name: str = Field(min_length=1, max_length=200)
    model: PassageModel


class UpdateModel(StrictModel):
    draft_id: UUID
    model: PassageModel


class CaptureModel(StrictModel):
    draft_id: UUID


class ReadModel(StrictModel):
    revision_id: UUID


class ReviewModel(ReadModel):
    decision: Literal["accepted", "rejected", "needs_evidence"]
    basis: Basis
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)


class InterpretModel(ReadModel):
    from_terminal_id: TerminalId
    to_terminal_id: TerminalId
    query: Literal["dc_continuity", "shortness", "resistance", "signal"]
    copper_assumption: Literal["unspecified", "ideal_zero_resistance"] = "unspecified"
    frequency_hz: ExactNumber | None = Field(default=None, gt=0)
    max_paths: int = Field(default=16, ge=1, le=32)
    max_hops: int = Field(default=32, ge=1, le=64)

    @model_validator(mode="after")
    def regime(self):
        if self.frequency_hz is not None and self.query != "signal":
            raise ValueError("Frequency applies only to the signal query.")
        return self
