"""Bodies, logical pinouts and declared boundary paths are independent contracts."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, TypeAdapter, model_validator

from specmate.assemblies.contracts import LocalId, Path, StrictModel, rename_keys
from specmate.contracts import FiniteNumber
from specmate.interfaces.assessment_contracts import InterfaceAssessment
from specmate.interfaces.board_contracts import Board
from specmate.interfaces.condition_contracts import ConditionalRating, Polarity
from specmate.interfaces.convention_contracts import ConductorConvention
from specmate.interfaces.end_assembly_contracts import EndAssembly
from specmate.interfaces.intent_contracts import CableIntent
from specmate.interfaces.signal_contracts import SignalImpedance, SignalLevel, SignalRef, SignalSet

ContactId = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S+$")]
Text = Annotated[str, Field(min_length=1, max_length=200)]
GeometryKey = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9.-]{0,79}$")]


class Orientation(StrictModel):
    viewing_side: Literal["mating", "termination", "unknown"] = "unknown"
    rotation_degrees: FiniteNumber | None = Field(default=None, ge=0, lt=360)
    datum: Text | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.viewing_side == "unknown" and (self.rotation_degrees is not None or self.datum):
            raise ValueError("Unknown viewing side cannot imply an orientation.")
        if (self.rotation_degrees is None) != (self.datum is None):
            raise ValueError("Rotation requires an explicit datum, and conversely.")
        return self


class Contact(StrictModel):
    contact_id: ContactId
    number: Text | None = None
    physical_role: Literal["contact", "shell", "key"] = "contact"
    label: str = Field(default="", max_length=200)
    position_mm: tuple[FiniteNumber, FiniteNumber] | None = None


class ContactPair(StrictModel):
    this: ContactId
    other: ContactId


class MatesWith(StrictModel):
    """A declared mating partner. Mating is never inferred from family names or labels."""

    body_revision_id: UUID
    # same_contact_id: every contact of this body meets the partner contact with the same ID.
    correspondence: Literal["same_contact_id", "explicit"] = "same_contact_id"
    pairs: list[ContactPair] = Field(default_factory=list, max_length=1000)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    basis: Text | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.review == "reviewed" and not self.basis:
            raise ValueError("A reviewed mating declaration requires its basis.")
        if self.correspondence == "explicit":
            if not self.pairs:
                raise ValueError("Explicit correspondence requires contact pairs.")
            unique([p.this for p in self.pairs])
            unique([p.other for p in self.pairs])
        elif self.pairs:
            raise ValueError("Same-ID correspondence lists no pairs.")
        return self


class ConnectorBody(StrictModel):
    kind: Literal["connector_body"] = "connector_body"
    schema_version: Literal["0.1"] = "0.1"
    family: Text | None = None
    mating_role: Literal["plug", "receptacle", "hermaphroditic", "unknown"] = "unknown"
    contacts: list[Contact] = Field(default_factory=list, max_length=1000)
    drawing_orientation: Orientation = Field(default_factory=Orientation)
    mates_with: list[MatesWith] = Field(default_factory=list, max_length=50)
    # Presentation only: the connector face drawing (a connector-art library key) this body
    # is drawn with. It never establishes mating, fit, contact identity or compatibility.
    geometry_key: GeometryKey | None = None

    @model_validator(mode="after")
    def unique(self):
        unique([c.contact_id for c in self.contacts])
        unique([str(m.body_revision_id) for m in self.mates_with])
        if any(c.position_mm is not None for c in self.contacts):
            if self.drawing_orientation.viewing_side == "unknown":
                raise ValueError("Contact coordinates require a known drawing side.")
        return self


PinRole = Literal["signal", "power", "return", "shield", "chassis", "unused", "unknown"]
ConditionKey = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,79}$")]


class ElectricalContract(StrictModel):
    """Declared limits and roles, never measured compatibility or conductor identity."""

    polarity: Polarity = "unknown"
    polarity_basis: Text | None = None
    conditional_ratings: list[ConditionalRating] = Field(default_factory=list, max_length=100)
    # Free-text display note; ``signal_ref`` is the exact typed signal identity.
    signal: Text | None = None
    signal_ref: SignalRef | None = None
    role: PinRole = "unknown"
    direction: Literal["input", "output", "bidirectional", "passive", "unknown"] = "unknown"
    voltage_min_v: FiniteNumber | None = None
    voltage_max_v: FiniteNumber | None = None
    current_max_a: FiniteNumber | None = Field(default=None, ge=0)
    protocol: Text | None = None
    condition: Text | None = None
    basis: Text | None = None

    @model_validator(mode="after")
    def valid_range(self):
        unique([r.local_id for r in self.conditional_ratings])
        if self.polarity != "unknown" and not self.polarity_basis:
            raise ValueError("Declared polarity requires its basis.")
        if self.voltage_min_v is not None and self.voltage_max_v is not None:
            if self.voltage_min_v > self.voltage_max_v:
                raise ValueError("Voltage range is reversed.")
        return self


class ConditionChoice(StrictModel):
    key: ConditionKey
    name: Text


class PinoutCondition(StrictModel):
    """A named device condition (for example a regional variant) that selects pin meanings."""

    key: ConditionKey
    name: Text
    choices: list[ConditionChoice] = Field(min_length=2, max_length=20)

    @model_validator(mode="after")
    def unique_choices(self):
        unique([c.key for c in self.choices])
        return self


class ConditionalSignal(StrictModel):
    """What one pin carries when a named condition takes one choice."""

    condition_key: ConditionKey
    choice: ConditionKey
    signal_ref: SignalRef | None = None
    signal: Text | None = None
    role: PinRole = "unknown"
    basis: Text

    @model_validator(mode="after")
    def names_something(self):
        if self.signal_ref is None and self.signal is None and self.role == "unknown":
            raise ValueError("A conditional pin meaning must name a signal or role.")
        return self


class Assignment(StrictModel):
    contact_id: ContactId
    electrical: ElectricalContract = Field(default_factory=ElectricalContract)
    # Conditional meanings: without a selected choice the pin's signal is unknown.
    alternatives: list[ConditionalSignal] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def one_condition(self):
        if self.alternatives:
            if len({a.condition_key for a in self.alternatives}) != 1:
                raise ValueError("A conditional pin depends on exactly one named condition.")
            unique([a.choice for a in self.alternatives])
            if self.electrical.signal_ref is not None:
                raise ValueError("A conditional pin has no unconditional typed signal.")
        return self


class Pinout(StrictModel):
    kind: Literal["pinout"] = "pinout"
    schema_version: Literal["0.1"] = "0.1"
    body_revision_id: UUID
    # A named variant of the pinned body ("Console A AV"); several variants share one body.
    variant_label: Text | None = None
    # The application's role and standard live on the variant, not on the body.
    role: Literal["source", "sink", "bidirectional", "unknown"] = "unknown"
    standard: Text | None = None
    conditions: list[PinoutCondition] = Field(default_factory=list, max_length=20)
    assignments: list[Assignment] = Field(default_factory=list, max_length=1000)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None
    orientation: Orientation = Field(default_factory=Orientation)

    @model_validator(mode="after")
    def consistent(self):
        unique([a.contact_id for a in self.assignments])
        unique([c.key for c in self.conditions])
        choices = {c.key: {choice.key for choice in c.choices} for c in self.conditions}
        for assignment in self.assignments:
            for alternative in assignment.alternatives:
                if alternative.choice not in choices.get(alternative.condition_key, ()):
                    raise ValueError("A conditional pin must name a declared condition choice.")
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed pinouts require a review basis.")
        return self


class CableNeed(StrictModel):
    """A part the cable must add for this pin, such as a series resistor."""

    conditioning: Literal[
        "series_resistor", "series_capacitor", "shunt_resistor", "attenuator", "other"
    ]
    value: Text | None = None
    basis: Text


class PortPin(StrictModel):
    """What the device does at one contact. Absent facts stay unknown."""

    contact_id: ContactId
    behavior: Literal["drives", "accepts", "passes", "none", "unknown"] = "unknown"
    level: SignalLevel = Field(default_factory=SignalLevel)
    impedance: SignalImpedance = Field(default_factory=SignalImpedance)
    coupling: Literal["ac", "dc", "unknown"] = "unknown"
    termination: Literal["source_terminated", "load_terminated", "none", "unknown"] = "unknown"
    needs_in_cable: list[CableNeed] = Field(default_factory=list, max_length=10)
    must_not_connect: bool = False
    must_not_connect_reason: Text | None = None
    basis: Text | None = None

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 0.1 pins spelled this key "behaviour".
        return rename_keys(value, {"behaviour": "behavior"})

    @model_validator(mode="after")
    def reasoned(self):
        if self.must_not_connect and not self.must_not_connect_reason:
            raise ValueError("A must-not-connect pin requires its reason.")
        if not self.must_not_connect and self.must_not_connect_reason:
            raise ValueError("Only a must-not-connect pin carries that reason.")
        return self


def upgrade_port_content(value):
    """Map schema 0.1 port content to 0.2 without validating it: pins spelled their device
    "behaviour" and now say "behavior". Other content is returned unchanged."""
    if not isinstance(value, dict) or value.get("schema_version", "0.1") != "0.1":
        return value
    pins = value.get("pins")
    if isinstance(pins, list):
        pins = [rename_keys(pin, {"behaviour": "behavior"}) for pin in pins]
    return {**value, "schema_version": "0.2", **({"pins": pins} if pins is not None else {})}


class Port(StrictModel):
    """A device socket or plug as the outside world sees it: one port per pinout variant."""

    kind: Literal["port"] = "port"
    schema_version: Literal["0.2"] = "0.2"
    device_label: Text
    pinout_revision_id: UUID
    role: Literal["source", "sink", "bidirectional", "unknown"] = "unknown"
    selected_conditions: dict[ConditionKey, ConditionKey] = Field(default_factory=dict)
    pins: list[PortPin] = Field(default_factory=list, max_length=1000)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 0.1 (stored or submitted) is read through the 0.2 shape.
        return upgrade_port_content(value)

    @model_validator(mode="after")
    def consistent(self):
        unique([p.contact_id for p in self.pins])
        if len(self.selected_conditions) > 20:
            raise ValueError("Too many selected conditions.")
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed ports require a review basis.")
        return self


class Terminal(StrictModel):
    path: Path = Field(min_length=1)
    revision_id: UUID
    feature_id: ContactId


class Passage(StrictModel):
    local_id: LocalId
    external_contact_id: ContactId
    internal: Terminal
    kind: Literal["declared_passage"] = "declared_passage"
    condition: Text | None = None
    basis: Text


class InterfaceMap(StrictModel):
    kind: Literal["interface_map"] = "interface_map"
    schema_version: Literal["0.1"] = "0.1"
    assembly_revision_id: UUID
    external_pinout_revision_id: UUID
    passages: list[Passage] = Field(default_factory=list, max_length=2000)

    @model_validator(mode="after")
    def unique_ids(self):
        unique([p.local_id for p in self.passages])
        return self


def unique(values):
    if len(values) != len(set(values)):
        raise ValueError("Duplicate stable ID.")


Interface = Annotated[
    ConnectorBody
    | Pinout
    | InterfaceMap
    | InterfaceAssessment
    | SignalSet
    | Port
    | Board
    | ConductorConvention
    | EndAssembly
    | CableIntent,
    Field(discriminator="kind"),
]
INTERFACE_ADAPTER = TypeAdapter(Interface)
KINDS = {
    "connector_body",
    "pinout",
    "interface_map",
    "interface_assessment",
    "signal_set",
    "port",
    "conductor_convention",
    "end_assembly",
    "cable_intent",
}
# Kinds that may also exist untyped: a generic board definition (for example a part in an
# assembly) has no interface content until its terminals and paths are declared.
OPTIONAL_KINDS = {"board"}


class CreateInterface(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
    name: Text
    interface: Interface


class UpdateInterface(StrictModel):
    draft_id: UUID
    interface: Interface


class CaptureInterface(StrictModel):
    draft_id: UUID


class ReadInterface(StrictModel):
    revision_id: UUID


class TraceInterface(ReadInterface):
    external_contact_id: ContactId
