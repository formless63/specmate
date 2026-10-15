"""Validate bounded derived JSON; this module never parses CAD."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from specmate.contracts import SHA256, FiniteNumber
from specmate.pcb import outline_geometry as geometry

Point = tuple[FiniteNumber, FiniteNumber]
Label = Annotated[str, Field(max_length=1024)]


EXACT_COVERAGE = ("closed-polygons-with-arcs", "closed-polygons-bridged")


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Component(Record):
    id: UUID
    reference: Label
    value: Label
    footprint: Label
    position: Point
    rotation_deg: FiniteNumber
    side: Literal["front", "back"]
    dnp: StrictBool
    exclude_from_bom: StrictBool


class Pad(Record):
    id: UUID
    component_id: UUID
    number: Label
    terminal: Label
    position: Point
    size: Point
    drill: Point
    rotation_deg: FiniteNumber
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
    resistance_ohm: FiniteNumber = Field(ge=0)


class LineEdge(Record):
    kind: Literal["line"]
    start: Point
    end: Point


class ArcEdge(Record):
    """Exact arc: start, mid and end as authored, plus the derived circle."""

    kind: Literal["arc"]
    start: Point
    mid: Point
    end: Point
    center: Point
    radius: FiniteNumber = Field(gt=0)
    sweep_deg: FiniteNumber


class BezierEdge(Record):
    """Cubic Bezier with its exact control points."""

    kind: Literal["bezier"]
    start: Point
    c1: Point
    c2: Point
    end: Point


class CircleEdge(Record):
    kind: Literal["circle"]
    center: Point
    radius: FiniteNumber = Field(gt=0)


Edge = Annotated[LineEdge | ArcEdge | BezierEdge | CircleEdge, Field(discriminator="kind")]
Loop = Annotated[list[Edge], Field(min_length=1, max_length=10000)]


def _check_loop(loop) -> None:
    raw = [e.model_dump() for e in loop]
    if raw[0]["kind"] == "circle":
        if len(raw) != 1:
            raise ValueError("a circle is a loop by itself")
        return
    if any(e["kind"] == "circle" for e in raw):
        raise ValueError("a circle cannot be chained with other edges")
    for edge in raw:
        if edge["kind"] == "arc":
            try:
                again = geometry.arc(edge["start"], edge["mid"], edge["end"])
            except ValueError as exc:
                raise ValueError("arc points disagree with its parameters") from exc
            if (
                geometry._dist(again["center"], edge["center"]) > 1e-4
                or abs(again["radius"] - edge["radius"]) > 1e-4
                or abs(again["sweep_deg"] - edge["sweep_deg"]) > 1e-4
            ):
                raise ValueError("arc center, radius or sweep disagree with start, mid and end")
    for a, b in zip(raw, [*raw[1:], raw[0]], strict=True):
        if geometry._dist(a["end"], b["start"]) > geometry.BRIDGE_MM:
            raise ValueError("exact outline loop is not closed and continuous")


class BridgedGap(Record):
    """An endpoint gap in the native outline that extraction closed with a straight chord."""

    at: Point
    to: Point
    size_mm: FiniteNumber = Field(gt=0)


class Coverage(Record):
    components: Literal["identity-reference-value-footprint-and-flags"]
    pads: Literal["identity-and-basic-geometry"]
    nets: Literal["pad-membership-not-connectivity-proof"]
    outline: Literal[
        "closed-line-polygons",
        "closed-polygons-with-arcs",
        "closed-polygons-bridged",
        "unsupported",
    ]
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
    # Exact geometry, present only with coverage "closed-polygons-with-arcs". The
    # polygons above are then display tessellations within outline_tolerance_mm.
    outline_exact: list[Loop] | None = Field(default=None, max_length=10000)
    cutouts_exact: list[Loop] | None = Field(default=None, max_length=10000)
    outline_tolerance_mm: FiniteNumber | None = Field(default=None, gt=0, le=1)
    # Gaps closed between exact edges (never silent): required with exact geometry, and
    # non-empty exactly when coverage is "closed-polygons-bridged".
    outline_bridged_gaps: list[BridgedGap] | None = Field(default=None, max_length=10000)
    chaining_tolerance_mm: FiniteNumber | None = Field(default=None, gt=0, le=1)
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
        if bool(self.outline) != (self.coverage.outline != "unsupported") or any(
            len(polygon) < 3 for polygon in (*self.outline, *self.cutouts)
        ):
            raise ValueError("outline coverage disagrees with geometry")
        exact = (
            self.outline_exact,
            self.cutouts_exact,
            self.outline_tolerance_mm,
            self.outline_bridged_gaps,
            self.chaining_tolerance_mm,
        )
        if (self.coverage.outline in EXACT_COVERAGE) != all(x is not None for x in exact) or (
            any(x is not None for x in exact) and any(x is None for x in exact)
        ):
            raise ValueError("exact outline fields disagree with outline coverage")
        if self.outline_exact is not None:
            listed = [
                {"at": list(g.at), "to": list(g.to), "size_mm": g.size_mm}
                for g in self.outline_bridged_gaps
            ]
            found = [
                gap
                for loop in (*self.outline_exact, *self.cutouts_exact)
                for gap in geometry.loop_gaps([e.model_dump() for e in loop])
            ]
            if listed != found or max((g["size_mm"] for g in found), default=0) > (
                self.chaining_tolerance_mm
            ):
                raise ValueError("bridged gaps must list every gap within the chaining tolerance")
            if bool(found) != (self.coverage.outline == "closed-polygons-bridged"):
                raise ValueError("bridged coverage disagrees with listed gaps")
            if len(self.outline_exact) != len(self.outline) or len(self.cutouts_exact) != len(
                self.cutouts
            ):
                raise ValueError("exact outline loops disagree with polygons")
            for loops, polygons in (
                (self.outline_exact, self.outline),
                (self.cutouts_exact, self.cutouts),
            ):
                for loop, polygon in zip(loops, polygons, strict=True):
                    _check_loop(loop)
                    try:
                        expected = geometry.tessellate(
                            [e.model_dump() for e in loop], self.outline_tolerance_mm
                        )
                    except ValueError as exc:
                        raise ValueError("exact outline cannot be tessellated") from exc
                    if [list(p) for p in polygon] != expected:
                        raise ValueError(
                            "outline polygon is not the tessellation of exact geometry"
                        )
        return self

    def outline_metrics(self) -> dict | None:
        """Bounding box and net area: exact when arcs are present, else from polygons."""
        if not self.outline:
            return None
        if self.outline_exact is not None:
            return geometry.metrics(
                [[e.model_dump() for e in loop] for loop in self.outline_exact],
                [[e.model_dump() for e in loop] for loop in self.cutouts_exact],
            )
        return polygon_metrics(self.outline, self.cutouts)


def polygon_area(polygon) -> float:
    return (
        abs(
            sum(
                x1 * y2 - x2 * y1
                for (x1, y1), (x2, y2) in zip(polygon, [*polygon[1:], polygon[0]], strict=True)
            )
        )
        / 2
    )


def polygon_metrics(outline, cutouts) -> dict:
    points = [p for polygon in outline for p in polygon]
    return {
        "bbox_mm": [
            min(x for x, _ in points),
            min(y for _, y in points),
            max(x for x, _ in points),
            max(y for _, y in points),
        ],
        "net_area_mm2": sum(polygon_area(p) for p in outline)
        - sum(polygon_area(p) for p in cutouts),
    }
