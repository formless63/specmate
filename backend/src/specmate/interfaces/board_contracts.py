"""Boards (PCBAs) as the outside world sees them: labelled terminals and declared paths.

A board terminal is a labelled pad, hole or contact; its label is display text and never
identity. A path declares how two terminals are joined on the board: straight copper,
through a component (for example a series resistor), through a switch or jumper state,
or in an unknown way. Paths are declarations with a basis, never measured continuity.

``InlineComponent`` is the shared description of a passive part on a signal path. Board
paths use it here; inline cable parts reuse it without a board.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.passive_passages.contracts import ExactNumber
from specmate.pcb.component_values import parse_capacitance, parse_resistance

TerminalKey = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,63}$")]
Key = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,79}$")]
Text = Annotated[str, Field(min_length=1, max_length=200)]
Basis = Annotated[str, Field(min_length=1, max_length=2000)]

# The passive interpreter's behaviour kinds; anything else is "unknown".
ComponentKind = Literal[
    "resistor", "capacitor", "diode", "inductor", "transformer", "active", "unknown"
]


class InlineComponent(StrictModel):
    """A part on a signal path: its kind, the value as written and exact parameters.

    The written value ("470 R", "220u") is kept as typed text. Exact parameters are
    stated separately; when both are present they must agree, nothing is guessed.
    """

    kind: ComponentKind = "unknown"
    value: Text | None = None
    reference: Text | None = None
    resistance_ohm: ExactNumber | None = Field(default=None, ge=0)
    capacitance_f: ExactNumber | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def consistent(self):
        if self.resistance_ohm is not None and self.kind != "resistor":
            raise ValueError("Only a resistor declares resistance.")
        if self.capacitance_f is not None and self.kind != "capacitor":
            raise ValueError("Only a capacitor declares capacitance.")
        if self.value is not None:
            if self.kind == "resistor" and self.resistance_ohm is not None:
                parsed = parse_resistance(self.value)
                if parsed is not None and parsed != self.resistance_ohm:
                    raise ValueError("The written value and the resistance disagree.")
            if self.kind == "capacitor" and self.capacitance_f is not None:
                parsed = parse_capacitance(self.value)
                if parsed is not None and parsed != self.capacitance_f:
                    raise ValueError("The written value and the capacitance disagree.")
        return self


def component_passage(component, local_id, from_id, to_id, basis, evidence, condition=None):
    """One passive-interpreter passage record for a component between two terminals."""
    return {
        "local_id": local_id,
        "from_terminal_id": from_id,
        "to_terminal_id": to_id,
        "kind": component.kind,
        "resistance_ohm": component.resistance_ohm,
        "capacitance_f": component.capacitance_f,
        "condition": condition,
        "conditional_contact": None,
        "basis": basis,
        "evidence": evidence,
    }


class BoardTerminal(StrictModel):
    terminal_id: TerminalKey
    # Silkscreen or drawing label ("R", "CS", "GND1"); display only, never identity.
    label: Text
    # Where the terminal sits, for example "Connector side" or "Cable side".
    group: Text | None = None
    kind: Literal["solder_pad", "through_hole", "connector_contact", "test_point", "unknown"] = (
        "unknown"
    )
    side: Literal["top", "bottom", "both", "unknown"] = "unknown"
    # Exact native pad identities when the terminal was derived from a KiCad interpretation.
    native_pad_ids: list[UUID] = Field(default_factory=list, max_length=50)
    note: Text | None = None


class TerminalContact(StrictModel):
    terminal_id: TerminalKey
    contact_id: Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S+$")]


class CarriedConnector(StrictModel):
    """A connector body this board carries, with which terminal lands on which contact."""

    local_id: Key
    body_revision_id: UUID
    correspondence: list[TerminalContact] = Field(default_factory=list, max_length=1000)
    # Unreviewed correspondence is a proposal: it reads unknown until reviewed.
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    basis: Basis | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.review == "reviewed" and not self.basis:
            raise ValueError("A reviewed connector correspondence requires its basis.")
        unique([p.terminal_id for p in self.correspondence])
        unique([p.contact_id for p in self.correspondence])
        return self


class BoardChoice(StrictModel):
    key: Key
    name: Text


class BoardCondition(StrictModel):
    """A switch or jumper with mutually exclusive named states."""

    key: Key
    name: Text
    choices: list[BoardChoice] = Field(min_length=2, max_length=20)

    @model_validator(mode="after")
    def unique_choices(self):
        unique([c.key for c in self.choices])
        return self


class SwitchState(StrictModel):
    condition_key: Key
    # The path is an ideal closed contact in this state and open in every other.
    closed_when: Key


class BoardPath(StrictModel):
    local_id: Key
    from_terminal: TerminalKey
    to_terminal: TerminalKey
    via: Literal["copper", "component", "switch", "unknown"]
    component: InlineComponent | None = None
    switch: SwitchState | None = None
    # How the path is known: declared by hand, or proposed from a native interpretation.
    provenance: Literal["declared", "reported_net_membership", "native_component_passage"] = (
        "declared"
    )
    basis: Basis

    @model_validator(mode="after")
    def shape(self):
        if self.from_terminal == self.to_terminal:
            raise ValueError("A path joins two different terminals.")
        if (self.via == "component") != (self.component is not None):
            raise ValueError("A component path, and only one, describes its component.")
        if (self.via == "switch") != (self.switch is not None):
            raise ValueError("A switch path, and only one, names its switch state.")
        if self.provenance == "reported_net_membership" and self.via != "copper":
            raise ValueError("Native net membership can only propose a copper path.")
        if self.provenance == "native_component_passage" and self.via != "component":
            raise ValueError("A native component passage can only propose a component path.")
        return self


class KicadOrigin(StrictModel):
    """The exact population revision (and its accepted interpretation) a board came from."""

    population_revision_id: UUID
    interpretation_id: UUID
    interpretation_sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class Board(StrictModel):
    kind: Literal["board"] = "board"
    schema_version: Literal["0.1"] = "0.1"
    origin: Literal["black_box", "kicad_derived"] = "black_box"
    derived_from: KicadOrigin | None = None
    terminals: list[BoardTerminal] = Field(default_factory=list, max_length=2000)
    carried_connectors: list[CarriedConnector] = Field(default_factory=list, max_length=20)
    conditions: list[BoardCondition] = Field(default_factory=list, max_length=20)
    paths: list[BoardPath] = Field(default_factory=list, max_length=5000)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def consistent(self):
        if (self.origin == "kicad_derived") != (self.derived_from is not None):
            raise ValueError("A KiCad-derived board, and only one, names its exact origin.")
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed boards require a review basis.")
        terminals = {t.terminal_id for t in self.terminals}
        unique([t.terminal_id for t in self.terminals])
        unique([c.local_id for c in self.carried_connectors])
        unique([c.key for c in self.conditions])
        unique([p.local_id for p in self.paths])
        if self.origin == "black_box":
            if any(t.native_pad_ids for t in self.terminals):
                raise ValueError("Only a KiCad-derived board names native pads.")
            if any(p.provenance != "declared" for p in self.paths):
                raise ValueError("Only a KiCad-derived board has natively proposed paths.")
        for connector in self.carried_connectors:
            for pair in connector.correspondence:
                if pair.terminal_id not in terminals:
                    raise ValueError("A connector correspondence names an undeclared terminal.")
        choices = {c.key: {x.key for x in c.choices} for c in self.conditions}
        for path in self.paths:
            if path.from_terminal not in terminals or path.to_terminal not in terminals:
                raise ValueError("A path names an undeclared terminal.")
            if path.switch and path.switch.closed_when not in choices.get(
                path.switch.condition_key, ()
            ):
                raise ValueError("A switch path must name a declared switch state.")
        return self


def unique(values):
    if len(values) != len(set(values)):
        raise ValueError("Duplicate stable ID.")


class BoardConditionAssignment(StrictModel):
    condition_id: Key
    state: Key


class TraceBoard(StrictModel):
    """Interpret the declared paths between two terminals of one frozen board revision."""

    revision_id: UUID
    from_terminal_id: TerminalKey
    to_terminal_id: TerminalKey
    query: Literal["dc_continuity", "shortness", "resistance", "signal"] = "dc_continuity"
    copper_assumption: Literal["unspecified", "ideal_zero_resistance"] = "unspecified"
    frequency_hz: ExactNumber | None = Field(default=None, gt=0)
    condition_assignments: list[BoardConditionAssignment] = Field(
        default_factory=list, max_length=20
    )
    max_paths: int = Field(default=16, ge=1, le=32)
    max_hops: int = Field(default=32, ge=1, le=64)

    @model_validator(mode="after")
    def regime(self):
        if self.frequency_hz is not None and self.query != "signal":
            raise ValueError("Frequency applies only to the signal query.")
        unique([a.condition_id for a in self.condition_assignments])
        return self


class ProposeBoard(StrictModel):
    """Propose board terminals and paths from one frozen PCB population revision."""

    population_revision_id: UUID
    # Components whose pads become terminals; omitted means those with port associations.
    component_ids: list[UUID] | None = Field(default=None, max_length=500)
