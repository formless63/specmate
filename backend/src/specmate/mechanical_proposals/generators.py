"""Deterministic planar proposal generators.

Pure functions over an accepted native board report and declared parameters. They
never write, never read files and never run a tool. A missing declaration keeps the
dependent feature incomplete: no wall, tolerance, clearance, envelope or height is
ever defaulted. Output geometry is planar in the native board frame (millimetres,
x right, y down). Passing every listed check is not a fit, printability, clearance
or manufacturing conclusion.
"""

import math
from collections.abc import Iterable
from itertools import pairwise

from specmate.mechanical_proposals.contracts import GENERATOR, Parameters
from specmate.pcb.report import Report

MAX_SLOTS = 2000
SIDES = ("west", "east", "north", "south")

REMAINING_CHECKS = [
    "Component and connector body heights and mating envelopes are not evaluated.",
    "Material, process shrinkage and printing/machining tolerances are not evaluated.",
    "Fastener, insert and thread fit are not evaluated.",
    "Thermal and airflow performance of any vent pattern is not evaluated.",
    "No collision, clearance, printability or manufacturability analysis has run.",
    "Board thickness, standoff and lid stack-up are physical facts to confirm by measurement.",
]


class UnknownReference(ValueError):
    """A declared native identity does not exist in the pinned board report."""


def num(value):
    if value is None:
        return None
    rounded = round(float(value), 6)
    return 0.0 if rounded == 0 else rounded


def point(p):
    return [num(p[0]), num(p[1])]


def rect(x0, y0, x1, y1):
    return {"x0": num(x0), "y0": num(y0), "x1": num(x1), "y1": num(y1)}


def _bbox(polygons: Iterable[list]):
    xs = [p[0] for polygon in polygons for p in polygon]
    ys = [p[1] for polygon in polygons for p in polygon]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def _area(polygon):
    total = 0.0
    for (x0, y0), (x1, y1) in zip(polygon, [*polygon[1:], polygon[0]], strict=True):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2


def _inside(polygon, x, y):
    inside = False
    for (x0, y0), (x1, y1) in zip(polygon, [*polygon[1:], polygon[0]], strict=True):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


def _segment_distance(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _boundary_distance(polygon, x, y):
    return min(
        _segment_distance(x, y, a, b)
        for a, b in zip(polygon, [*polygon[1:], polygon[0]], strict=True)
    )


def _circle_rect_overlap(cx, cy, radius, x0, y0, x1, y1):
    nearest_x = max(x0, min(cx, x1))
    nearest_y = max(y0, min(cy, y1))
    return math.hypot(cx - nearest_x, cy - nearest_y) < radius


class Builder:
    def __init__(self, report: Report, parameters: Parameters):
        self.report = report
        self.p = parameters
        self.features: list[dict] = []
        self.unresolved: list[dict] = []
        self.facts: list[dict] = []
        self.limitations: list[str] = []

    # -- bookkeeping -----------------------------------------------------------
    def need(self, feature_id, parameter, value, message):
        """Return value; record an explicit unresolved input when it is unknown."""
        if value is None:
            self.unresolved.append(
                {
                    "feature_id": feature_id,
                    "code": "unknown_input",
                    "parameter": parameter,
                    "message": message,
                }
            )
        return value

    def unresolved_note(self, feature_id, code, parameter, message):
        self.unresolved.append(
            {"feature_id": feature_id, "code": code, "parameter": parameter, "message": message}
        )

    def fact(self, name, value, origin):
        if value is not None:
            self.facts.append({"name": name, "value": value, "origin": origin})

    @staticmethod
    def check(code, ok, detail):
        status = "not_evaluated" if ok is None else ("pass" if ok else "fail")
        return {"code": code, "status": status, "detail": detail}

    def add(self, feature_id, kind, geometry, parameters_used, checks=(), notes=()):
        own = [u for u in self.unresolved if u["feature_id"] == feature_id]
        self.features.append(
            {
                "feature_id": feature_id,
                "kind": kind,
                "geometry": geometry,
                "parameters_used": parameters_used,
                "unresolved": [u["parameter"] for u in own],
                "checks": list(checks),
                "notes": list(notes),
            }
        )

    # -- board facts -------------------------------------------------------------
    def board(self):
        report = self.report
        env = _bbox(report.outline)
        self.env = env
        if env is None:
            self.unresolved_note(
                "enclosure_outline",
                "board_outline_unavailable",
                "board.outline",
                "The accepted board report supplies no closed outline; nothing is inferred.",
            )
        else:
            self.fact("board_envelope_mm", rect(*env), "board_report")
        self.cavity = None
        self.outer = None

    def shell(self):
        s = self.p.shell
        fid = "enclosure_outline"
        env = self.env
        clearance = self.need(
            fid, "shell.board_clearance_mm", s.board_clearance_mm, "Board clearance is unknown."
        )
        wall = self.need(fid, "shell.wall_mm", s.wall_mm, "Wall thickness is unknown.")
        radius = s.corner_radius_mm
        self.need(
            fid, "shell.interior_height_mm", s.interior_height_mm, "Interior height is unknown."
        )
        notes = []
        checks = []
        geometry = {
            "type": "rounded_rectangle_pair",
            "board_envelope": rect(*env) if env else None,
            "cavity": None,
            "outer": None,
            "corner_radius_mm": num(radius),
            "interior_height_mm": num(s.interior_height_mm),
        }
        if env is not None:
            notes.append(
                "Envelope is the axis-aligned bounding rectangle of the native outline; "
                "it is not an offset of the actual outline."
            )
            polygons = self.report.outline
            if len(polygons) != 1 or abs(_area(polygons[0]) - self._envelope_area()) > 1e-6:
                notes.append("The native outline is not a single axis-aligned rectangle.")
            if clearance is not None:
                self.cavity = (
                    env[0] - clearance,
                    env[1] - clearance,
                    env[2] + clearance,
                    env[3] + clearance,
                )
                geometry["cavity"] = rect(*self.cavity)
                self.fact("board_clearance_mm", num(clearance), "declared")
                if wall is not None:
                    c = self.cavity
                    self.outer = (c[0] - wall, c[1] - wall, c[2] + wall, c[3] + wall)
                    geometry["outer"] = rect(*self.outer)
                    self.fact("wall_mm", num(wall), "declared")
            if radius is not None and self.cavity is not None:
                half = min(self.cavity[2] - self.cavity[0], self.cavity[3] - self.cavity[1]) / 2
                checks.append(
                    self.check(
                        "corner_radius_within_cavity",
                        radius <= half,
                        f"radius {num(radius)} mm against half the shorter cavity side "
                        f"{num(half)} mm",
                    )
                )
        if s.board_thickness_mm is not None:
            self.fact("board_thickness_mm", num(s.board_thickness_mm), "declared")
        if s.interior_height_mm is not None:
            self.fact("interior_height_mm", num(s.interior_height_mm), "declared")
        self.add(
            fid,
            "enclosure_outline",
            geometry,
            {
                "board_clearance_mm": num(clearance),
                "wall_mm": num(wall),
                "corner_radius_mm": num(radius),
                "interior_height_mm": num(s.interior_height_mm),
            },
            checks,
            notes,
        )

    def _envelope_area(self):
        e = self.env
        return (e[2] - e[0]) * (e[3] - e[1])

    # -- mounting bosses -----------------------------------------------------------
    def mounts(self):
        holes = {h.pad_id: h for h in self.report.mounting_holes}
        choices = {m.pad_id: m.use for m in self.p.mounts}
        for pad_id in choices:
            if pad_id not in holes:
                raise UnknownReference(f"Mounting choice {pad_id} is not a native hole identity.")
        b = self.p.boss
        self.selected = []
        outline = self.report.outline
        for hole in sorted(self.report.mounting_holes, key=lambda h: str(h.pad_id)):
            fid = f"boss:{hole.pad_id}"
            decision = choices.get(hole.pad_id)
            if decision is None:
                self.unresolved_note(
                    fid,
                    "unreviewed_mount_candidate",
                    "mounts",
                    "Non-plated hole is a candidate only; choose whether it is a mount.",
                )
                self.add(
                    fid,
                    "mount_candidate",
                    {
                        "type": "hole",
                        "center": point(hole.position),
                        "drill_mm": point(hole.drill),
                        "decision": "unreviewed",
                    },
                    {},
                )
                continue
            if not decision:
                self.add(
                    fid,
                    "mount_candidate",
                    {
                        "type": "hole",
                        "center": point(hole.position),
                        "drill_mm": point(hole.drill),
                        "decision": "declined",
                    },
                    {},
                )
                continue
            outer = self.need(
                fid, "boss.outer_diameter_mm", b.outer_diameter_mm, "Boss diameter is unknown."
            )
            pilot = self.need(
                fid, "boss.pilot_diameter_mm", b.pilot_diameter_mm, "Pilot diameter is unknown."
            )
            height = self.need(fid, "boss.height_mm", b.height_mm, "Standoff height is unknown.")
            lid_hole = self.need(
                fid,
                "boss.lid_clearance_diameter_mm",
                b.lid_clearance_diameter_mm,
                "Lid fastener clearance diameter is unknown.",
            )
            x, y = hole.position
            checks = []
            if outline:
                checks.append(
                    self.check(
                        "center_inside_outline",
                        any(_inside(poly, x, y) for poly in outline),
                        "Native hole centre against the closed outline polygons.",
                    )
                )
            for poly in self.report.cutouts:
                near = _boundary_distance(poly, x, y)
                inside = _inside(poly, x, y)
                clear = None if outer is None else (not inside and near >= outer / 2)
                checks.append(
                    self.check(
                        "boss_clear_of_cutout",
                        clear,
                        f"centre to cutout boundary {num(near)} mm"
                        + ("; centre inside the cutout" if inside else ""),
                    )
                )
            if pilot is not None and outer is not None:
                checks.append(
                    self.check(
                        "pilot_smaller_than_boss",
                        pilot < outer,
                        f"pilot {num(pilot)} mm, boss {num(outer)} mm",
                    )
                )
            if self.cavity is not None and outer is not None:
                c = self.cavity
                r = outer / 2
                checks.append(
                    self.check(
                        "boss_within_cavity",
                        x - r >= c[0] and x + r <= c[2] and y - r >= c[1] and y + r <= c[3],
                        "Boss circle against the plan cavity rectangle.",
                    )
                )
            self.selected.append((hole, fid, outer))
            self.add(
                fid,
                "mount_boss",
                {
                    "type": "boss",
                    "center": point(hole.position),
                    "native_hole_drill_mm": point(hole.drill),
                    "outer_diameter_mm": num(outer),
                    "pilot_diameter_mm": num(pilot),
                    "height_mm": num(height),
                    "lid_clearance_diameter_mm": num(lid_hole),
                    "decision": "mount",
                },
                {
                    "outer_diameter_mm": num(outer),
                    "pilot_diameter_mm": num(pilot),
                    "height_mm": num(height),
                    "lid_clearance_diameter_mm": num(lid_hole),
                },
                checks,
                ["Position is the native hole centre; the mounting purpose is a declared choice."],
            )
        # pairwise overlaps among chosen bosses with known diameters
        extra = []
        for i, (h1, f1, d1) in enumerate(self.selected):
            for h2, f2, d2 in self.selected[i + 1 :]:
                if d1 is None or d2 is None:
                    continue
                dist = math.hypot(h1.position[0] - h2.position[0], h1.position[1] - h2.position[1])
                if dist < (d1 + d2) / 2:
                    extra.append((f1, f2, dist))
        for f1, f2, dist in extra:
            for feature in self.features:
                if feature["feature_id"] in (f1, f2):
                    feature["checks"].append(
                        self.check("boss_overlap", False, f"{f1} and {f2} centres {num(dist)} mm")
                    )

    # -- connector openings --------------------------------------------------------
    def wall_axis(self, side):
        # Wall running direction: west/east walls run along y, north/south along x.
        return 1 if side in ("west", "east") else 0

    def connectors(self):
        components = {c.id: c for c in self.report.components}
        s = self.p.shell
        b = self.p.boss
        self.opening_spans: dict[str, list[tuple[str, float, float]]] = {}
        for decl in sorted(self.p.connectors, key=lambda d: str(d.component_id)):
            comp = components.get(decl.component_id)
            if comp is None:
                raise UnknownReference(
                    f"Connector opening {decl.component_id} is not a native component identity."
                )
            fid = f"connector_opening:{comp.id}"
            width = self.need(fid, "connector.width_mm", decl.width_mm, "Opening width unknown.")
            height = self.need(
                fid, "connector.height_mm", decl.height_mm, "Opening height unknown."
            )
            clearance = self.need(
                fid, "connector.clearance_mm", decl.clearance_mm, "Opening clearance unknown."
            )
            offset = self.need(
                fid,
                "connector.lateral_offset_mm",
                decl.lateral_offset_mm,
                "Connector centreline offset from the component origin is unknown.",
            )
            axis = self.wall_axis(decl.side)
            lateral = None if offset is None else comp.position[axis] + offset
            size_w = None if width is None or clearance is None else width + 2 * clearance
            size_h = None if height is None or clearance is None else height + 2 * clearance
            z = None
            if comp.side != "front":
                self.unresolved_note(
                    fid,
                    "vertical_reference_unavailable",
                    "connector.center_above_board_mm",
                    "Back-side component: vertical placement reference is not established.",
                )
            else:
                needed = (
                    decl.center_above_board_mm,
                    s.board_thickness_mm,
                    b.height_mm,
                )
                names = (
                    "connector.center_above_board_mm",
                    "shell.board_thickness_mm",
                    "boss.height_mm",
                )
                missing = [n for n, v in zip(names, needed, strict=True) if v is None]
                for name in missing:
                    self.need(fid, name, None, f"{name} is needed for the opening height.")
                if not missing:
                    z = b.height_mm + s.board_thickness_mm + decl.center_above_board_mm
            wall_coord = None
            if self.cavity is not None:
                c = self.cavity
                wall_coord = {"west": c[0], "east": c[2], "north": c[1], "south": c[3]}[decl.side]
            checks = []
            span = None
            if lateral is not None and size_w is not None:
                span = (lateral - size_w / 2, lateral + size_w / 2)
                self.opening_spans.setdefault(decl.side, []).append((fid, *span))
                if self.cavity is not None:
                    c = self.cavity
                    lo, hi = (c[1], c[3]) if axis == 1 else (c[0], c[2])
                    checks.append(
                        self.check(
                            "opening_within_wall_span",
                            span[0] >= lo and span[1] <= hi,
                            f"opening span {num(span[0])}..{num(span[1])} mm "
                            f"against cavity wall {num(lo)}..{num(hi)} mm",
                        )
                    )
            distance = None
            if wall_coord is not None:
                distance = abs(comp.position[1 - axis] - wall_coord)
            self.add(
                fid,
                "connector_opening",
                {
                    "type": "wall_opening",
                    "side": decl.side,
                    "component": {
                        "component_id": str(comp.id),
                        "reference": comp.reference,
                        "value": comp.value,
                        "footprint": comp.footprint,
                        "origin": point(comp.position),
                        "board_side": comp.side,
                    },
                    "lateral_center_mm": num(lateral),
                    "width_mm": num(size_w),
                    "height_mm": num(size_h),
                    "center_z_above_floor_mm": num(z),
                    "origin_to_wall_mm": num(distance),
                    "wall_coordinate_mm": num(wall_coord),
                },
                {
                    "lateral_offset_mm": num(offset),
                    "envelope_width_mm": num(width),
                    "envelope_height_mm": num(height),
                    "clearance_mm": num(clearance),
                    "center_above_board_mm": num(decl.center_above_board_mm),
                },
                checks,
                [
                    "Connector body and mating plug envelopes are declared sizes, not extracted "
                    "geometry. The component origin is not the connector centreline."
                ],
            )
        for side, spans in self.opening_spans.items():
            ordered = sorted(spans, key=lambda s: s[1])
            for (f1, _, hi1), (f2, lo2, _) in pairwise(ordered):
                gap = lo2 - hi1
                for feature in self.features:
                    if feature["feature_id"] in (f1, f2):
                        feature["checks"].append(
                            self.check(
                                "openings_separate",
                                gap > 0,
                                f"{side} wall gap between {f1} and {f2}: {num(gap)} mm",
                            )
                        )

    # -- vents ---------------------------------------------------------------------
    def vents(self):
        for decl in sorted(self.p.vents, key=lambda v: v.local_id):
            fid = f"vent:{decl.local_id}"
            w = self.need(fid, "vent.slot_width_mm", decl.slot_width_mm, "Slot width unknown.")
            length = self.need(
                fid, "vent.slot_length_mm", decl.slot_length_mm, "Slot length unknown."
            )
            px = self.need(fid, "vent.pitch_x_mm", decl.pitch_x_mm, "Pitch along x unknown.")
            py = self.need(fid, "vent.pitch_y_mm", decl.pitch_y_mm, "Pitch along y unknown.")
            margin = self.need(
                fid, "vent.edge_margin_mm", decl.edge_margin_mm, "Edge margin unknown."
            )
            keepout = self.need(
                fid, "vent.keepout_margin_mm", decl.keepout_margin_mm, "Boss keep-out unknown."
            )
            if self.cavity is None:
                self.unresolved_note(
                    fid,
                    "cavity_unavailable",
                    "shell",
                    "A vent region needs a known cavity (outline, clearance).",
                )
            blockers = [d for _, _, d in self.selected if d is None]
            if blockers:
                self.unresolved_note(
                    fid,
                    "boss_diameter_unavailable",
                    "boss.outer_diameter_mm",
                    "Chosen mounts have unknown boss diameters; vent keep-out cannot be applied.",
                )
            geometry = {
                "type": "slot_grid",
                "face": decl.face,
                "region": None,
                "slot_width_mm": num(w),
                "slot_length_mm": num(length),
                "slots": None,
                "removed_for_bosses": None,
                "geometric_open_area_mm2": None,
            }
            checks = []
            if (
                None not in (w, length, px, py, margin, keepout)
                and self.cavity is not None
                and not blockers
            ):
                c = self.cavity
                region = (c[0] + margin, c[1] + margin, c[2] - margin, c[3] - margin)
                geometry["region"] = rect(*region)
                rw, rh = region[2] - region[0], region[3] - region[1]
                nx = int((rw - length) // px) + 1 if rw >= length else 0
                ny = int((rh - w) // py) + 1 if rh >= w else 0
                if nx * ny > MAX_SLOTS:
                    self.unresolved_note(
                        fid,
                        "slot_count_exceeds_bound",
                        "vent.pitch_x_mm",
                        f"The pattern exceeds the {MAX_SLOTS}-slot proposal bound.",
                    )
                else:
                    cx0 = (region[0] + region[2]) / 2 - (nx - 1) * px / 2
                    cy0 = (region[1] + region[3]) / 2 - (ny - 1) * py / 2
                    slots, removed = [], 0
                    for ix in range(nx):
                        for iy in range(ny):
                            cx, cy = cx0 + ix * px, cy0 + iy * py
                            blocked = any(
                                _circle_rect_overlap(
                                    h.position[0],
                                    h.position[1],
                                    d / 2 + keepout,
                                    cx - length / 2,
                                    cy - w / 2,
                                    cx + length / 2,
                                    cy + w / 2,
                                )
                                for h, _, d in self.selected
                            )
                            if blocked:
                                removed += 1
                            else:
                                slots.append(point((cx, cy)))
                    geometry["slots"] = slots
                    geometry["removed_for_bosses"] = removed
                    geometry["geometric_open_area_mm2"] = num(len(slots) * w * length)
                    checks.append(
                        self.check(
                            "vent_has_slots",
                            len(slots) > 0,
                            f"{len(slots)} slots after {removed} boss keep-out removals",
                        )
                    )
                    self.fact(f"{fid}.slot_count", len(slots), "derived")
            self.add(
                fid,
                "vent_array",
                geometry,
                {
                    "pitch_x_mm": num(px),
                    "pitch_y_mm": num(py),
                    "edge_margin_mm": num(margin),
                    "keepout_margin_mm": num(keepout),
                },
                checks,
                [
                    "Geometric open area is a plan-view area, not a thermal or airflow claim; "
                    "slot corners are square."
                ],
            )

    # -- cable guides --------------------------------------------------------------
    def cable_guides(self):
        for decl in sorted(self.p.cable_guides, key=lambda g: g.local_id):
            fid = f"cable_guide:{decl.local_id}"
            offset = self.need(
                fid,
                "guide.offset_along_wall_mm",
                decl.offset_along_wall_mm,
                "Guide position along the wall is unknown.",
            )
            d = self.need(
                fid, "guide.cable_diameter_mm", decl.cable_diameter_mm, "Cable diameter unknown."
            )
            clearance = self.need(
                fid, "guide.clearance_mm", decl.clearance_mm, "Guide clearance unknown."
            )
            post_w = self.need(
                fid, "guide.post_width_mm", decl.post_width_mm, "Post width unknown."
            )
            post_d = self.need(
                fid, "guide.post_depth_mm", decl.post_depth_mm, "Post depth unknown."
            )
            axis = self.wall_axis(decl.side)
            geometry = {
                "type": "post_pair",
                "side": decl.side,
                "slot_width_mm": None,
                "slot_center_mm": None,
                "posts": None,
            }
            checks = []
            if self.cavity is None:
                self.unresolved_note(
                    fid, "cavity_unavailable", "shell", "A guide needs a known cavity wall."
                )
            if None not in (offset, d, clearance, post_w, post_d) and self.cavity is not None:
                c = self.cavity
                lo, hi = (c[1], c[3]) if axis == 1 else (c[0], c[2])
                wall = {"west": c[0], "east": c[2], "north": c[1], "south": c[3]}[decl.side]
                inward = 1 if decl.side in ("west", "north") else -1
                slot = d + clearance
                center = lo + offset
                posts = []
                for sign in (-1, 1):
                    a0 = center + sign * slot / 2
                    a1 = a0 + sign * post_w
                    b0, b1 = wall, wall + inward * post_d
                    low, high = sorted((a0, a1))
                    lat = (low, high)
                    dep = tuple(sorted((b0, b1)))
                    box = (
                        rect(dep[0], lat[0], dep[1], lat[1])
                        if axis == 1
                        else rect(lat[0], dep[0], lat[1], dep[1])
                    )
                    posts.append(box)
                geometry.update(slot_width_mm=num(slot), slot_center_mm=num(center), posts=posts)
                outer_lo = center - slot / 2 - post_w
                outer_hi = center + slot / 2 + post_w
                checks.append(
                    self.check(
                        "guide_within_wall_span",
                        outer_lo >= lo and outer_hi <= hi,
                        f"guide span {num(outer_lo)}..{num(outer_hi)} mm "
                        f"against cavity wall {num(lo)}..{num(hi)} mm",
                    )
                )
                for other, olo, ohi in self.opening_spans.get(decl.side, []):
                    checks.append(
                        self.check(
                            "guide_clear_of_opening",
                            outer_hi <= olo or outer_lo >= ohi,
                            f"against {other}",
                        )
                    )
            self.add(
                fid,
                "cable_guide",
                geometry,
                {
                    "offset_along_wall_mm": num(offset),
                    "cable_diameter_mm": num(d),
                    "clearance_mm": num(clearance),
                    "post_width_mm": num(post_w),
                    "post_depth_mm": num(post_d),
                },
                checks,
                [
                    "Offset is measured from the low-coordinate end of the cavity wall. "
                    "Cable bend radius and routing are not evaluated."
                ],
            )


def generate(report: Report, parameters: Parameters) -> dict:
    """Return the canonical proposal document for one board and one declaration set."""
    b = Builder(report, parameters)
    b.board()
    b.shell()
    b.mounts()
    b.connectors()
    b.vents()
    b.cable_guides()
    failed = sum(1 for f in b.features for c in f["checks"] if c["status"] == "fail")
    passed = sum(1 for f in b.features for c in f["checks"] if c["status"] == "pass")
    not_eval = sum(1 for f in b.features for c in f["checks"] if c["status"] == "not_evaluated")
    for f in b.features:
        f["status"] = "incomplete" if f["unresolved"] else "declared_inputs_complete"
    return {
        "generator": GENERATOR,
        "units": "mm",
        "frame": "native board frame: x right, y down; west=min x, north=min y",
        "status": "incomplete" if b.unresolved else "declared_inputs_complete",
        "features": b.features,
        "unresolved": b.unresolved,
        "facts_used": b.facts,
        "checks_summary": {"pass": passed, "fail": failed, "not_evaluated": not_eval},
        "remaining_physical_checks": REMAINING_CHECKS,
        "limitations": [
            "Planar proposal only; no solid, mesh or native CAD is produced.",
            "Hole centres are native non-plated drills; mounting purpose is a declared choice.",
            *report.unsupported,
        ],
        "qualification": {
            "physical": False,
            "fit": "not_evaluated",
            "clearance": "not_evaluated",
            "printability": "not_evaluated",
            "manufacturing": "not_evaluated",
        },
    }
