"""Exact board-outline geometry: lines, arcs and circles; chaining, tessellation, metrics.

Pure standard-library code with no application imports, so the same source runs in
the app (validation, metrics) and, embedded verbatim, in the trusted native program.
Coordinates are millimeters in the KiCad frame (x right, y down). Angles are measured
with atan2 over the coordinates as given; a positive sweep is increasing atan2 angle.
Stroke width of Edge.Cuts items is ignored (the centerline is the outline).
"""

import math
from itertools import pairwise

TOLERANCE_MM = 0.005  # maximum chord sagitta of display tessellation
CHAIN_EPSILON_MM = 0.01  # items whose points all lie within this are zero-length, not edges
COINCIDENT_MM = 1e-4  # endpoints closer than this coincide; larger gaps are bridged explicitly
BRIDGE_MM = 0.05  # largest endpoint gap that is bridged (and always reported)
MAX_STEPS = 4096


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def circle_through(start, mid, end):
    """Center, radius and signed sweep (radians) of the arc start->mid->end."""
    (ax, ay), (bx, by), (cx, cy) = start, mid, end
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        raise ValueError("arc points are collinear")
    a2, b2, c2 = ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
    radius = math.hypot(ax - ux, ay - uy)
    a0, am, a1 = (math.atan2(p[1] - uy, p[0] - ux) for p in (start, mid, end))
    ccw = (am - a0) % (2 * math.pi)
    total = (a1 - a0) % (2 * math.pi)
    sweep = total if ccw <= total else total - 2 * math.pi
    return (ux, uy), radius, sweep


def line(start, end):
    return {"kind": "line", "start": list(start), "end": list(end)}


def arc(start, mid, end):
    """Exact arc edge: the given points plus the derived center, radius and sweep."""
    center, radius, sweep = circle_through(start, mid, end)
    return {
        "kind": "arc",
        "start": list(start),
        "mid": list(mid),
        "end": list(end),
        "center": [center[0], center[1]],
        "radius": radius,
        "sweep_deg": math.degrees(sweep),
    }


def bezier(start, c1, c2, end):
    """Cubic Bezier edge keeping its exact control points."""
    return {
        "kind": "bezier",
        "start": list(start),
        "c1": list(c1),
        "c2": list(c2),
        "end": list(end),
    }


def circle(center, radius):
    return {"kind": "circle", "center": list(center), "radius": radius}


def _ends(edge):
    return tuple(edge["start"]), tuple(edge["end"])


def is_degenerate(edge, epsilon=CHAIN_EPSILON_MM):
    """A line or Bezier whose points all coincide has no extent and is not an edge."""
    if edge["kind"] not in ("line", "bezier"):
        return False
    pts = [edge[k] for k in ("start", "c1", "c2", "end") if k in edge]
    return all(_dist(p, pts[0]) <= epsilon for p in pts)


def chain(edges, epsilon=BRIDGE_MM):
    """Group line/arc/Bezier edges into closed loops (circles are loops of one edge).

    Returns (loops, open_count). A loop is a list of edges, each reversed when needed
    so that every edge starts near where the previous one ended; endpoint gaps up to
    epsilon are bridged (see loop_gaps). Edges that do not close are counted in
    open_count and omitted.
    """
    loops, pending = [], []
    for edge in edges:
        (loops if edge["kind"] == "circle" else pending).append(
            [edge] if edge["kind"] == "circle" else edge
        )
    open_count = 0
    while pending:
        current = [pending.pop(0)]
        head = tuple(current[0]["start"])
        tail = tuple(current[0]["end"])
        while _dist(head, tail) > COINCIDENT_MM:
            best = None
            for i, edge in enumerate(pending):
                s, e = _ends(edge)
                for d, flip in ((_dist(s, tail), False), (_dist(e, tail), True)):
                    if d <= epsilon and (best is None or d < best[0]):
                        best = (d, i, flip)
            if best is None or (len(current) > 1 and _dist(head, tail) <= best[0]):
                break
            edge = pending.pop(best[1])
            edge = reverse(edge) if best[2] else edge
            current.append(edge)
            tail = tuple(edge["end"])
        if _dist(head, tail) <= epsilon and (len(current) > 1 or current[0]["kind"] == "arc"):
            loops.append(current)
        else:
            open_count += len(current)
    return loops, open_count


def loop_gaps(loop):
    """Every endpoint gap in a loop larger than coincidence, as explicit records."""
    if loop[0]["kind"] == "circle":
        return []
    gaps = []
    for a, b in zip(loop, [*loop[1:], loop[0]], strict=True):
        size = _dist(a["end"], b["start"])
        if size > COINCIDENT_MM:
            gaps.append({"at": list(a["end"]), "to": list(b["start"]), "size_mm": round(size, 6)})
    return gaps


def reverse(edge):
    if edge["kind"] == "line":
        return line(edge["end"], edge["start"])
    if edge["kind"] == "arc":
        return arc(edge["end"], edge["mid"], edge["start"])
    if edge["kind"] == "bezier":
        return bezier(edge["end"], edge["c2"], edge["c1"], edge["start"])
    return edge


def _flat(p0, p1, p2, p3, tolerance):
    """Control-polygon flatness bound: curve deviates from its chord by <= 3/4 max."""
    dx, dy = p3[0] - p0[0], p3[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 1e-12:
        d = max(_dist(p1, p0), _dist(p2, p0))
    else:
        d = max(abs((p[0] - p0[0]) * dy - (p[1] - p0[1]) * dx) / length for p in (p1, p2))
    return 0.75 * d <= tolerance


def _mid(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def _bezier_points(edge, tolerance):
    """Adaptive de Casteljau subdivision; returns vertices after start, ending at end."""
    out = []

    def split(p0, p1, p2, p3, depth):
        if depth >= 20 or _flat(p0, p1, p2, p3, tolerance):
            out.append(p3)
            return
        a, b, c = _mid(p0, p1), _mid(p1, p2), _mid(p2, p3)
        d, e = _mid(a, b), _mid(b, c)
        f = _mid(d, e)
        split(p0, a, d, f, depth + 1)
        split(f, e, c, p3, depth + 1)

    pts = [tuple(edge[k]) for k in ("start", "c1", "c2", "end")]
    split(*pts, 0)
    if len(out) > MAX_STEPS:
        raise ValueError("curve cannot be tessellated within the tolerance")
    return out


def _arc_points(edge, tolerance):
    c, r, sweep = tuple(edge["center"]), edge["radius"], math.radians(edge["sweep_deg"])
    if r <= tolerance:
        return [tuple(edge["end"])]
    step = 2 * math.acos(1 - tolerance / r)
    n = max(2, math.ceil(abs(sweep) / step))
    if n > MAX_STEPS:
        raise ValueError("arc cannot be tessellated within the tolerance")
    a0 = math.atan2(edge["start"][1] - c[1], edge["start"][0] - c[0])
    pts = [
        (c[0] + r * math.cos(a0 + sweep * k / n), c[1] + r * math.sin(a0 + sweep * k / n))
        for k in range(1, n)
    ]
    return [*pts, tuple(edge["end"])]


def tessellate(loop, tolerance=TOLERANCE_MM):
    """Closed polygon (no repeated end vertex) whose chords deviate <= tolerance."""
    first = loop[0]
    if first["kind"] == "circle":
        c, r = first["center"], first["radius"]
        step = 2 * math.acos(1 - min(tolerance / r, 1))
        n = max(8, math.ceil(2 * math.pi / step))
        if n > MAX_STEPS:
            raise ValueError("circle cannot be tessellated within the tolerance")
        pts = [
            (c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n))
            for k in range(n)
        ]
    else:
        pts = [tuple(first["start"])]
        for i, edge in enumerate(loop):
            if i and _dist(loop[i - 1]["end"], edge["start"]) > COINCIDENT_MM:
                pts.append(tuple(edge["start"]))  # bridged gap: straight chord
            if edge["kind"] == "arc":
                pts.extend(_arc_points(edge, tolerance))
            elif edge["kind"] == "bezier":
                pts.extend(_bezier_points(edge, tolerance))
            else:
                pts.append(tuple(edge["end"]))
        if _dist(pts[-1], pts[0]) <= COINCIDENT_MM:
            pts.pop()  # the closing vertex repeats the first one
    return [[round(x, 6), round(y, 6)] for x, y in pts]


def signed_area(loop, tolerance=TOLERANCE_MM):
    """Signed area: exact for lines, arcs and circles; Bezier edges contribute the
    area under their tessellation at the tolerance (approximate within tolerance)."""
    if loop[0]["kind"] == "circle":
        return math.pi * loop[0]["radius"] ** 2
    total = 0.0
    for edge in loop:
        if edge["kind"] in ("line", "bezier"):
            path = [tuple(edge["start"])]
            if edge["kind"] == "bezier":
                path += _bezier_points(edge, tolerance)
            else:
                path.append(tuple(edge["end"]))
            total += sum(a[0] * b[1] - b[0] * a[1] for a, b in pairwise(path))
        else:
            (cx, cy), r = edge["center"], edge["radius"]
            a0 = math.atan2(edge["start"][1] - cy, edge["start"][0] - cx)
            s = math.radians(edge["sweep_deg"])
            a1 = a0 + s
            total += (
                r * r * s
                + r * cx * (math.sin(a1) - math.sin(a0))
                - r * cy * (math.cos(a1) - math.cos(a0))
            )
    for a, b in zip(loop, [*loop[1:], loop[0]], strict=True):
        if _dist(a["end"], b["start"]) > COINCIDENT_MM:  # bridged gap
            total += a["end"][0] * b["start"][1] - b["start"][0] * a["end"][1]
    return total / 2


def area(loop, tolerance=TOLERANCE_MM):
    return abs(signed_area(loop, tolerance))


def is_approximate(loops):
    """True when any loop's area rests on a tessellated Bezier edge."""
    return any(e["kind"] == "bezier" for loop in loops for e in loop)


def _bezier_extrema(edge):
    pts = [edge[k] for k in ("start", "c1", "c2", "end")]
    ts = [0.0, 1.0]
    for axis in (0, 1):
        p0, p1, p2, p3 = (p[axis] for p in pts)
        a, b, c = -p0 + 3 * p1 - 3 * p2 + p3, 2 * (p0 - 2 * p1 + p2), p1 - p0
        if abs(a) < 1e-12:
            roots = [-c / b] if abs(b) > 1e-12 else []
        else:
            disc = b * b - 4 * a * c
            roots = (
                [] if disc < 0 else [(-b + sign * math.sqrt(disc)) / (2 * a) for sign in (1, -1)]
            )
        ts += [t for t in roots if 0 < t < 1]
    points = []
    for t in ts:
        u = 1 - t
        points.append(
            tuple(
                u**3 * pts[0][i]
                + 3 * u * u * t * pts[1][i]
                + 3 * u * t * t * pts[2][i]
                + t**3 * pts[3][i]
                for i in (0, 1)
            )
        )
    return points


def bbox(loop):
    """Exact axis-aligned bounds [minx, miny, maxx, maxy], including arc extrema."""
    first = loop[0]
    if first["kind"] == "circle":
        (cx, cy), r = first["center"], first["radius"]
        return [cx - r, cy - r, cx + r, cy + r]
    xs = [p[0] for e in loop for p in (e["start"], e["end"])]
    ys = [p[1] for e in loop for p in (e["start"], e["end"])]
    for edge in loop:
        if edge["kind"] == "bezier":
            xs += [p[0] for p in _bezier_extrema(edge)]
            ys += [p[1] for p in _bezier_extrema(edge)]
        if edge["kind"] != "arc":
            continue
        (cx, cy), r = edge["center"], edge["radius"]
        a0 = math.atan2(edge["start"][1] - cy, edge["start"][0] - cx)
        s = math.radians(edge["sweep_deg"])
        for k in range(4):
            axis = k * math.pi / 2
            off = (axis - a0) % (2 * math.pi) if s > 0 else (a0 - axis) % (2 * math.pi)
            if off <= abs(s):
                xs.append(cx + r * math.cos(axis))
                ys.append(cy + r * math.sin(axis))
    return [min(xs), min(ys), max(xs), max(ys)]


def _inside(polygon, point):
    x, y = point
    hit = False
    for (x0, y0), (x1, y1) in zip(polygon, [*polygon[1:], polygon[0]], strict=True):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def classify(loops, tolerance=TOLERANCE_MM):
    """Split loops into (outline_loops, cutout_loops) by nesting depth parity."""
    polys = [tessellate(loop, tolerance) for loop in loops]
    outline, cutouts = [], []
    for i, poly in enumerate(polys):
        depth = sum(1 for j, other in enumerate(polys) if j != i and _inside(other, poly[0]))
        (cutouts if depth % 2 else outline).append(i)
    return outline, cutouts


def build(edges, tolerance=TOLERANCE_MM, epsilon=BRIDGE_MM):
    """Exact edge list -> dict of exact loops and tessellated polygons, or None."""
    loops, open_count = chain(edges, epsilon)
    if open_count or not loops:
        return None
    outer, holes = classify(loops, tolerance)
    if not outer:
        return None
    return {
        "outline_exact": [loops[i] for i in outer],
        "cutouts_exact": [loops[i] for i in holes],
        "outline": [tessellate(loops[i], tolerance) for i in outer],
        "cutouts": [tessellate(loops[i], tolerance) for i in holes],
        "tolerance_mm": tolerance,
        "chaining_tolerance_mm": epsilon,
        "bridged_gaps": [g for i in [*outer, *holes] for g in loop_gaps(loops[i])],
    }


def metrics(outline_exact, cutouts_exact):
    """Exact bounding box and net area of the outline minus cutouts."""
    boxes = [bbox(loop) for loop in outline_exact]
    return {
        "bbox_mm": [
            min(b[0] for b in boxes),
            min(b[1] for b in boxes),
            max(b[2] for b in boxes),
            max(b[3] for b in boxes),
        ],
        "net_area_mm2": sum(area(loop) for loop in outline_exact)
        - sum(area(loop) for loop in cutouts_exact),
        "area_approximate": is_approximate([*outline_exact, *cutouts_exact]),
    }
