"""Bodies, logical pinouts and declared boundary paths are independent contracts."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, TypeAdapter, model_validator

from specmate.assemblies.contracts import LocalId, Path, StrictModel
from specmate.contracts import FiniteNumber
from specmate.interfaces.assessment_contracts import InterfaceAssessment

ContactId = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S+$")]
Text = Annotated[str, Field(min_length=1, max_length=200)]


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
    physical_role: Literal["contact", "shell", "key"] = "contact"
    label: str = Field(default="", max_length=200)
    position_mm: tuple[FiniteNumber, FiniteNumber] | None = None


class ConnectorBody(StrictModel):
    kind: Literal["connector_body"] = "connector_body"
    schema_version: Literal["0.1"] = "0.1"
    family: Text | None = None
    mating_role: Literal["plug", "receptacle", "hermaphroditic", "unknown"] = "unknown"
    contacts: list[Contact] = Field(default_factory=list, max_length=1000)
    drawing_orientation: Orientation = Field(default_factory=Orientation)

    @model_validator(mode="after")
    def unique(self):
        unique([c.contact_id for c in self.contacts])
        if any(c.position_mm is not None for c in self.contacts):
            if self.drawing_orientation.viewing_side == "unknown":
                raise ValueError("Contact coordinates require a known drawing side.")
        return self


class ElectricalContract(StrictModel):
    """Declared limits and roles, never measured compatibility or conductor identity."""

    signal: Text | None = None
    role: Literal["signal", "power", "return", "shield", "chassis", "unused", "unknown"] = "unknown"
    direction: Literal["input", "output", "bidirectional", "passive", "unknown"] = "unknown"
    voltage_min_v: FiniteNumber | None = None
    voltage_max_v: FiniteNumber | None = None
    current_max_a: FiniteNumber | None = Field(default=None, ge=0)
    protocol: Text | None = None
    condition: Text | None = None
    basis: Text | None = None

    @model_validator(mode="after")
    def valid_range(self):
        if self.voltage_min_v is not None and self.voltage_max_v is not None:
            if self.voltage_min_v > self.voltage_max_v:
                raise ValueError("Voltage range is reversed.")
        return self


class Assignment(StrictModel):
    contact_id: ContactId
    electrical: ElectricalContract = Field(default_factory=ElectricalContract)


class Pinout(StrictModel):
    kind: Literal["pinout"] = "pinout"
    schema_version: Literal["0.1"] = "0.1"
    body_revision_id: UUID
    assignments: list[Assignment] = Field(default_factory=list, max_length=1000)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None
    orientation: Orientation = Field(default_factory=Orientation)

    @model_validator(mode="after")
    def consistent(self):
        unique([a.contact_id for a in self.assignments])
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed pinouts require a review basis.")
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
    ConnectorBody | Pinout | InterfaceMap | InterfaceAssessment, Field(discriminator="kind")
]
INTERFACE_ADAPTER = TypeAdapter(Interface)
KINDS = {"connector_body", "pinout", "interface_map", "interface_assessment"}


class CreateInterface(StrictModel):
    project_id: UUID
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
