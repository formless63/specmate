"""Shared stock placement and fit findings.

Placement is the one definition of where each element sits in the section: a node's
position is its parent's position plus its own ``x_mm``/``y_mm`` offset, plus, for
members (conductors and nested groups) of a ring, linear or figure-eight group, the
arrangement displacement from the group's pitch. A member of an arranged group with
an unknown pitch, or any element with a null (unknown) offset, has an unknown position.
``packages/section-layout/src/placement.ts`` implements the same rule for every
drawing; both sides are tested against ``tests/fixtures/wire-stock-placement.json``.

Fit findings compare placed outer circles with enclosing bores and with sibling
elements, within a stated tolerance. A check whose dimension or position is unknown
is reported as not evaluated; it never passes. Findings describe the declared
geometry only: they are not clearance, manufacturing or physical qualification.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

TOLERANCE_MM = 0.001
# Kinds that are hollow layers unless an inner diameter of zero says otherwise.
TUBE_KINDS = frozenset({"dielectric", "insulation", "shield", "jacket"})
MEMBER_KINDS = frozenset({"group", "conductor"})


@dataclass
class Placed:
    path: str
    kind: str
    parent: str
    x: float | None
    y: float | None
    r_out: float | None
    r_in: float | None
    tube: bool
    node: dict = field(default_factory=dict, repr=False)


@dataclass
class PlacedGroup:
    path: str
    node: dict
    x: float | None
    y: float | None


@dataclass
class Placement:
    # Pre-order: each group precedes its descendants, children in declared order.
    nodes: list[Placed | PlacedGroup] = field(default_factory=list)
    # Members placed by an arrangement that also carry a manual offset.
    offset_members: list[tuple[str, str]] = field(default_factory=list)

    @property
    def leaves(self) -> list[Placed]:
        return [n for n in self.nodes if isinstance(n, Placed)]

    @property
    def groups(self) -> list[tuple[str, dict]]:
        return [(n.path, n.node) for n in self.nodes if isinstance(n, PlacedGroup)]


def _arranged_offset(node: dict, members: list[dict], index: int) -> tuple[float, float]:
    pitch = node["pitch_mm"]
    count = len(members)
    if node["arrangement"] == "ring":
        step = (-1 if node.get("direction", "ccw") == "ccw" else 1) * 2 * math.pi / count
        angle = -math.pi / 2 + step * index
        return pitch / 2 * math.cos(angle), pitch / 2 * math.sin(angle)
    return (index - (count - 1) / 2) * pitch, 0.0


def _leaf(node: dict, path: str, parent: str, x: float | None, y: float | None) -> Placed:
    if node["kind"] == "web":
        w, h = node.get("width_mm"), node.get("height_mm")
        r_out = None if w is None or h is None else math.hypot(w, h) / 2
        return Placed(path, "web", parent, x, y, r_out, None, False, node)
    outer, inner = node.get("outer_diameter_mm"), node.get("inner_diameter_mm")
    tube = (inner is not None and inner > 0) or (inner is None and node["kind"] in TUBE_KINDS)
    return Placed(
        path,
        node["kind"],
        parent,
        x,
        y,
        None if outer is None else outer / 2,
        None if inner is None else inner / 2,
        tube,
        node,
    )


def place(structure: dict) -> Placement:
    """Place every element of a stock structure (a validated JSON dict)."""
    result = Placement()

    def visit(node: dict, path: str, parent: str, x: float | None, y: float | None) -> None:
        # An unknown (null) offset makes the position unknown, never zero.
        ox, oy = node.get("x_mm", 0), node.get("y_mm", 0)
        px = None if x is None or ox is None else x + ox
        py = None if y is None or oy is None else y + oy
        if node["kind"] != "group":
            result.nodes.append(_leaf(node, path, parent, px, py))
            return
        result.nodes.append(PlacedGroup(path, node, px, py))
        children = node.get("children", [])
        members = [c for c in children if c["kind"] in MEMBER_KINDS]
        arranged = node.get("arrangement", "concentric") != "concentric"
        pitch = node.get("pitch_mm")
        for child in children:
            child_path = f"{path}.{child['id']}"
            placed = arranged and any(child is m for m in members)
            if placed and (child.get("x_mm", 0) != 0 or child.get("y_mm", 0) != 0):
                result.offset_members.append((child_path, path))
            if placed and pitch is None:
                visit(child, child_path, path, None, None)
                continue
            dx, dy = (0.0, 0.0)
            if placed:
                index = next(i for i, m in enumerate(members) if m is child)
                dx, dy = _arranged_offset(node, members, index)
            visit(
                child,
                child_path,
                path,
                None if px is None else px + dx,
                None if py is None else py + dy,
            )

    visit(structure, structure["id"], "", 0.0, 0.0)
    return result


def fmt(value: float) -> str:
    """Half-up millimetre text, identical in the browser."""
    return f"{math.floor(value * 1000 + 0.5) / 1000:.3f}"


def _unit(leaf: Placed, group: str) -> str:
    """Name a finding by the core (the leaf's own group) below the checked group."""
    return leaf.path if leaf.parent == group else leaf.parent


def _known(*leaves: Placed) -> bool:
    return all(
        leaf.x is not None and leaf.y is not None and leaf.r_out is not None for leaf in leaves
    )


class _Checks:
    def __init__(self):
        self.items: dict[tuple, dict] = {}

    def record(self, key: tuple, base: dict, outcome: tuple[str, str, float] | None) -> None:
        """outcome: None (unknown), ("pass", ...), or ("fail", code, excess)."""
        current = self.items.setdefault(key, {**base, "status": "pass", "excess_mm": None})
        if outcome is None:
            if current["status"] == "pass":
                current["status"] = "not_evaluated"
            return
        status, code, excess = outcome
        if status == "fail" and (current["status"] != "fail" or excess > current["excess_mm"]):
            current.update(status="fail", code=code, excess_mm=excess)


def _tube_outcome(leaf: Placed, tube: Placed, outermost: bool) -> tuple[str, str, float] | None:
    if not _known(leaf, tube) or tube.r_in is None:
        return None
    d = math.hypot(leaf.x - tube.x, leaf.y - tube.y)
    if leaf.tube:
        if leaf.r_in is None:
            if d + tube.r_out <= leaf.r_out + TOLERANCE_MM:
                return None  # could enclose the tube; its bore is unknown
        elif leaf.r_in + TOLERANCE_MM >= d + tube.r_out:
            return ("pass", "containment", 0.0)
    if d + leaf.r_out <= tube.r_in + TOLERANCE_MM:
        return ("pass", "containment", 0.0)
    if d - leaf.r_out >= tube.r_out - TOLERANCE_MM:
        return ("fail", "outside", d + leaf.r_out - tube.r_in) if outermost else ("pass", "", 0.0)
    if d - leaf.r_out < tube.r_in:
        # Partly within the bore: it does not fit inside the enclosing layer.
        return ("fail", "containment", d + leaf.r_out - tube.r_in)
    return ("fail", "wall_overlap", tube.r_out - (d - leaf.r_out))


def _message(item: dict) -> str:
    a, b = item["paths"]
    if item["status"] == "not_evaluated":
        if item["code"] == "overlap":
            return f"{a} and {b}: overlap not evaluated; a dimension or position is unknown."
        return f"{a} within {b}: not evaluated; a dimension or position is unknown."
    excess = fmt(item["excess_mm"])
    return {
        "containment": f"{a} extends {excess} mm beyond the bore of {b}.",
        "wall_overlap": f"{a} overlaps the wall of {b} by {excess} mm.",
        "outside": f"{a} lies outside {b}, the outer layer of {item['group']}.",
        "overlap": f"{a} and {b} overlap by {excess} mm.",
    }[item["code"]]


def evaluate(stock: dict) -> dict:
    """Fit findings for a stock specification JSON dict; deterministic order."""
    placement = place(stock["structure"])
    leaves = placement.leaves
    checks = _Checks()
    for group_path, node in placement.groups:
        prefix = group_path + "."
        subtree = [leaf for leaf in leaves if leaf.path.startswith(prefix)]
        tubes = [leaf for leaf in subtree if leaf.parent == group_path and leaf.tube]
        radii = [t.r_out for t in tubes]
        outer = max(radii) if tubes and None not in radii else None
        for tube in tubes:
            for leaf in subtree:
                if leaf is tube:
                    continue
                unit = _unit(leaf, group_path)
                checks.record(
                    ("tube", unit, tube.path),
                    {"code": "containment", "paths": [unit, tube.path], "group": group_path},
                    _tube_outcome(leaf, tube, tube.r_out == outer),
                )
        children = [
            c
            for c in node.get("children", [])
            if c["kind"] != "web" and not any(t.path == f"{prefix}{c['id']}" for t in tubes)
        ]
        for i, first in enumerate(children):
            first_path = f"{prefix}{first['id']}"
            first_leaves = [
                leaf
                for leaf in subtree
                if leaf.kind != "web"
                and (leaf.path == first_path or leaf.path.startswith(first_path + "."))
            ]
            for second in children[i + 1 :]:
                second_path = f"{prefix}{second['id']}"
                second_leaves = [
                    leaf
                    for leaf in subtree
                    if leaf.kind != "web"
                    and (leaf.path == second_path or leaf.path.startswith(second_path + "."))
                ]
                for a in first_leaves:
                    for b in second_leaves:
                        ua, ub = _unit(a, group_path), _unit(b, group_path)
                        outcome = None
                        if _known(a, b):
                            depth = a.r_out + b.r_out - math.hypot(a.x - b.x, a.y - b.y)
                            outcome = (
                                ("fail", "overlap", depth)
                                if depth > TOLERANCE_MM
                                else ("pass", "overlap", 0.0)
                            )
                        checks.record(
                            ("pair", ua, ub),
                            {"code": "overlap", "paths": [ua, ub], "group": group_path},
                            outcome,
                        )
    findings = []
    for item in checks.items.values():
        if item["status"] == "pass":
            continue
        item["excess_mm"] = None if item["excess_mm"] is None else round(item["excess_mm"], 6)
        if item["status"] == "not_evaluated":
            item["excess_mm"] = None
        item["message"] = _message(item)
        findings.append(item)
    notes = [
        {
            "code": "offset_on_arranged",
            "status": "note",
            "paths": [member, group],
            "group": group,
            "excess_mm": None,
            "message": (
                f"{member} has a manual offset added to its arranged position in {group}; "
                "arranged members are placed by pitch, so offsets move them twice."
            ),
        }
        for member, group in placement.offset_members
    ]
    failed = sum(1 for f in findings if f["status"] == "fail")
    unknown = sum(1 for f in findings if f["status"] == "not_evaluated")
    total = len(checks.items)
    status = (
        "problems" if failed else "incomplete" if unknown else "ok" if total else "nothing_to_check"
    )
    return {
        "status": status,
        "tolerance_mm": TOLERANCE_MM,
        "checks": total,
        "failed": failed,
        "not_evaluated": unknown,
        "findings": findings + notes,
    }


def positions(stock: dict) -> dict[str, list[float] | None]:
    """Leaf path -> [x, y] in millimetres, or None when the position is unknown."""
    return {
        leaf.path: None if leaf.x is None or leaf.y is None else [leaf.x, leaf.y]
        for leaf in place(stock["structure"]).leaves
    }
