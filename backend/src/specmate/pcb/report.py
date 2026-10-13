"""Validate bounded derived JSON; this module never parses CAD."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator

from specmate.contracts import SHA256

Point = tuple[FiniteFloat, FiniteFloat]
Label = Annotated[str, Field(max_length=1024)]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Component(Record):
    id: UUID
    reference: Label
    value: Label
    footprint: Label
    position: Point
    rotation_deg: FiniteFloat
    side: Literal["front", "back"]
    dnp: bool
    exclude_from_bom: bool


class Pad(Record):
    id: UUID
    component_id: UUID
    number: Label
    terminal: Label
    position: Point
    size: Point
    drill: Point
    rotation_deg: FiniteFloat
    type: Literal["smd", "pth", "npth", "connector", "unknown"]
    shape: Label
    net: Label
    layers: list[Label] = Field(max_length=128)


class Hole(Record):
    pad_id: UUID
    position: Point
    drill: Point
    mounting_status: Literal["candidate-not-reviewed"]


class Passage(Record):
    kind: Literal["resistor"]
    first: Label = Field(alias="from")
    to: Label
    resistance_ohm: FiniteFloat = Field(ge=0)


class Coverage(Record):
    components: Literal["identity-reference-value-footprint-and-flags"]
    pads: Literal["identity-and-basic-geometry"]
    nets: Literal["pad-membership-not-connectivity-proof"]
    outline: Literal["closed-line-polygons", "unsupported"]
    holes: Literal["nonplated-pad-drills-not-reviewed-mounts"]
    placements: Literal["native-absolute"]


class Report(Record):
    format_version: Literal[1]
    adapter: Literal["kicad-intake-v1"]
    tool_version: Literal["10.0.6"]
    native_format_version: Literal[20260206]
    source_sha256: str = Field(pattern=SHA256)
    units: Literal["mm"]
    coordinate_frame: Literal["KiCad absolute: x right, y down; angles native degrees"]
    components: list[Component] = Field(max_length=100000)
    pads: list[Pad] = Field(max_length=200000)
    copper_nets: dict[Label, list[Label]]
    outline: list[list[Point]] = Field(max_length=10000)
    cutouts: list[list[Point]] = Field(max_length=10000)
    mounting_holes: list[Hole] = Field(max_length=100000)
    component_passages: list[Passage] = Field(max_length=100000)
    coverage: Coverage
    unsupported: list[Label] = Field(min_length=4, max_length=10000)
    physical_qualification: Literal[False]

    @model_validator(mode="after")
    def identities_and_coverage(self):
        components = {c.id: c for c in self.components}
        pads = {p.id: p for p in self.pads}
        if len(components) != len(self.components) or len(pads) != len(self.pads):
            raise ValueError("native component and pad identities must be unique")
        nets = {}
        for pad in self.pads:
            if pad.component_id not in components:
                raise ValueError("pad references a missing component")
            if pad.terminal != f"{components[pad.component_id].reference}.{pad.number}":
                raise ValueError("pad terminal label disagrees with native identity")
            if any(n < 0 for n in (*pad.size, *pad.drill)):
                raise ValueError("negative pad or drill geometry")
            if pad.net and pad.type != "npth":
                nets.setdefault(pad.net, []).append(pad.terminal)
        if {n: sorted(t) for n, t in nets.items()} != self.copper_nets:
            raise ValueError("net memberships must agree with native pads")
        if len({h.pad_id for h in self.mounting_holes}) != len(self.mounting_holes):
            raise ValueError("duplicate nonplated hole identity")
        for hole in self.mounting_holes:
            pad = pads.get(hole.pad_id)
            if (
                pad is None
                or pad.type != "npth"
                or hole.position != pad.position
                or hole.drill != pad.drill
                or min(hole.drill) <= 0
            ):
                raise ValueError("hole disagrees with native pad drill")
        if {h.pad_id for h in self.mounting_holes} != {p.id for p in self.pads if p.type == "npth"}:
            raise ValueError("nonplated pad drill coverage is incomplete")
        if bool(self.outline) != (self.coverage.outline == "closed-line-polygons") or any(
            len(polygon) < 3 for polygon in (*self.outline, *self.cutouts)
        ):
            raise ValueError("outline coverage disagrees with geometry")
        return self
