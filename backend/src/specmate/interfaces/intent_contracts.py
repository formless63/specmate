"""Cable intent: what a cable must connect, between two ends, signal by signal.

Each end is a device port or a bare pinout variant (a destination may be given either
way). Rows say which from-contact must reach which to-contacts, what it carries, what
return and conductor it needs, which parts the cable must add, and which pins must not
be connected. A row that the proposal could not decide carries an explicit question; it
stays open until a person answers it, and an intent with open questions cannot freeze.

Rows are requirements, never evidence: checking a cable against them (``cable_intent``
check) and wiring a cable from them (proposal) are separate, later steps.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_serializer, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.contracts import FiniteNumber
from specmate.interfaces.board_contracts import Key
from specmate.interfaces.signal_contracts import SignalRef

Text = Annotated[str, Field(min_length=1, max_length=200)]
Basis = Annotated[str, Field(min_length=1, max_length=2000)]
Contact = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S+$")]


class ConductorRequirement(StrictModel):
    """The conductor a row needs; unknown unless a port or pin fact states it."""

    kind: Literal["coax", "pair", "single", "any", "unknown"] = "unknown"
    impedance_ohm: FiniteNumber | None = Field(default=None, gt=0)
    basis: Basis | None = None

    @model_validator(mode="after")
    def stated(self):
        if self.impedance_ohm is not None and self.kind in ("any", "unknown"):
            raise ValueError("An impedance requirement names its conductor kind.")
        if self.kind != "unknown" and not self.basis:
            raise ValueError("A conductor requirement records its basis.")
        return self


class RequiredPart(StrictModel):
    """A part the cable must add on this row, carried from a port fact."""

    conditioning: Literal[
        "series_resistor", "series_capacitor", "shunt_resistor", "attenuator", "other"
    ]
    value: Text | None = None
    where: Literal["anywhere", "from_end", "to_end"] = "anywhere"
    basis: Basis


class QuestionOption(StrictModel):
    contact_id: Contact
    label: Text


class Question(StrictModel):
    """Why a row is undecided and which destination contacts could answer it."""

    kind: Literal["several_destinations", "name_and_type_only", "conditional_pin"]
    text: Basis
    options: list[QuestionOption] = Field(default_factory=list, max_length=200)


class IntentRow(StrictModel):
    row_id: Key
    requirement: Literal["required", "optional", "must_not_connect"] = "required"
    from_contact_id: Contact | None = None
    to_contact_ids: list[Contact] = Field(default_factory=list, max_length=50)
    signal_ref: SignalRef | None = None
    # None retains the original strict per-row check; global isolation is separate.
    isolation: Literal["no_unlisted_connections", "unlisted_allowed", "unknown"] | None = None
    # How the two ends were paired: by exact signal identity, by a person, or not at all.
    pairing: Literal["same_signal", "answered", "declared", "unpaired"] = "declared"
    return_policy: Literal[
        "dedicated_screen", "shared_ground", "any", "not_applicable", "unknown"
    ] = "unknown"
    conductor: ConductorRequirement = Field(default_factory=ConductorRequirement)
    required_parts: list[RequiredPart] = Field(default_factory=list, max_length=10)
    question: Question | None = None
    basis: Basis | None = None

    @model_serializer(mode="wrap")
    def omit_unrecorded_isolation(self, handler):
        data = handler(self)
        if data.get("isolation") is None:
            data.pop("isolation", None)
        return data

    @model_validator(mode="after")
    def shape(self):
        if self.from_contact_id is None and not self.to_contact_ids:
            raise ValueError("A row names at least one contact.")
        if len(self.to_contact_ids) != len(set(self.to_contact_ids)):
            raise ValueError("A row names each destination contact once.")
        if self.requirement == "must_not_connect" and not self.basis:
            raise ValueError("A must-not-connect row records its reason.")
        if self.question is not None and self.pairing in ("same_signal", "answered"):
            raise ValueError("A paired row has no open question.")
        if self.pairing == "answered" and not self.basis:
            raise ValueError("An answered row records who or what decided it.")
        return self


class ShieldPolicy(StrictModel):
    policy: Literal["bond_from", "bond_to", "bond_both", "isolated", "unknown"] = "unknown"
    basis: Basis | None = None

    @model_validator(mode="after")
    def stated(self):
        if self.policy != "unknown" and not self.basis:
            raise ValueError("A shield policy records its basis.")
        return self


class CableIntent(StrictModel):
    kind: Literal["cable_intent"] = "cable_intent"
    schema_version: Literal["0.1"] = "0.1"
    # Each end is an exact device port or pinout variant revision.
    from_revision_id: UUID
    to_revision_id: UUID
    description: Text | None = None
    rows: list[IntentRow] = Field(default_factory=list, max_length=500)
    # Whether any connection not listed as a row is forbidden.
    isolation: Literal["no_unlisted_connections", "unlisted_allowed", "unknown"] = "unknown"
    shield: ShieldPolicy = Field(default_factory=ShieldPolicy)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def consistent(self):
        ids = [r.row_id for r in self.rows]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate row ID.")
        sources = [r.from_contact_id for r in self.rows if r.from_contact_id]
        if len(sources) != len(set(sources)):
            raise ValueError("Each from-contact appears in one row.")
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("A reviewed intent requires a review basis.")
        if self.review == "reviewed" and any(r.question for r in self.rows):
            raise ValueError("An intent with open questions cannot be reviewed.")
        return self

    @property
    def open_questions(self):
        return [r for r in self.rows if r.question is not None]


class ProposeIntent(StrictModel):
    """Propose rows between two ends; nothing is stored."""

    from_revision_id: UUID
    to_revision_id: UUID
