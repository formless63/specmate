# ruff: noqa: E501  (SVG templates mirror the TypeScript renderer line for line)
"""Deterministic server-side formboard print of one exact harness revision.

This is a Python port of the browser renderer in `packages/harness-views` (formboard
layout, tiled print plan and page SVG) and of the stock appearance it reads from
`packages/section-layout`. It exists so the print can be retained and packaged without a
browser or Node runtime. Number formatting mirrors JavaScript `String(Math.round(...))`
so the SVG bytes match the TypeScript output for the same inputs (the tests compare
against a golden produced by the TypeScript renderer).

Only the length axis is to scale, and only for sections with a recorded planned cut
length. Sections without one are drawn at a labelled, dashed placeholder length. Nothing
here implies routing, electrical connection, fit or manufacturing approval.

Only the print path is ported: no selection highlight, scale bar, labels or build sheet.
Backend stock colours are `#rrggbb` or null; named-colour parsing is kept for parity.
"""

import math
import re
from dataclasses import dataclass, field

# ------------------------------------------------------------------ number formatting


def js(value):
    """JavaScript `String(number)` for the finite values this renderer produces."""
    if value == 0:
        return "0"
    if float(value).is_integer() and abs(value) < 1e21:
        return str(int(value))
    return repr(float(value))


def _round(value):
    return math.floor(value + 0.5)


def n2(value):
    return js(_round(value * 100) / 100)


def n3(value):
    return js(_round(value * 1000) / 1000)


def esc(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


# ------------------------------------------------------------------ stock appearance

NAMED_COLORS = {
    "black": "#1b1b1d",
    "brown": "#6b4423",
    "red": "#c62828",
    "orange": "#e8741c",
    "yellow": "#f2c20f",
    "green": "#1f8a3d",
    "blue": "#1f5fbf",
    "violet": "#7a3fa0",
    "purple": "#7a3fa0",
    "grey": "#8a9096",
    "gray": "#8a9096",
    "white": "#f4f4f0",
    "pink": "#e58ab0",
    "turquoise": "#2bb5b0",
    "tan": "#c8a97a",
    "natural": "#e9e4d0",
    "clear": "#dfe7ea",
    "gold": "#c9a227",
    "silver": "#c0c4c8",
    "copper": "#b87333",
}
UNKNOWN_FILL = "#7d838b"
_HEX = re.compile(r"^#([0-9a-f]{6})$", re.I)
_SHORT = re.compile(r"^#([0-9a-f])([0-9a-f])([0-9a-f])$", re.I)

# family: (is_metal, typical colour)
_FAMILY = {
    "copper": (True, "#b87333"),
    "tinned-copper": (True, "#c3c8cb"),
    "silver-plated-copper": (True, "#d5d8db"),
    "nickel-plated-copper": (True, "#aeb2b4"),
    "copper-clad-aluminium": (True, "#b87333"),
    "aluminium": (True, "#c9ced3"),
    "steel": (True, "#9aa0a6"),
    "aluminium-foil": (True, "#d2d7dc"),
}
_RULES = [
    (r"copper[- ]?clad[- ]?alumin|\bcca\b", "copper-clad-aluminium"),
    (r"tinned|tin[- ]?plated|\bsn[- ]?cu\b", "tinned-copper"),
    (r"silver|\bag[- ]?cu\b", "silver-plated-copper"),
    (r"nickel|\bni[- ]?cu\b", "nickel-plated-copper"),
    (
        r"(alumin(i)?um|\bal\b).*(foil|mylar|laminate|tape)|"
        r"(foil|mylar|laminate).*(alumin(i)?um|\bal\b)",
        "aluminium-foil",
    ),
    (r"\bcopper\b|\bcu\b|\bofc\b|\betp\b", "copper"),
    (r"alumin(i)?um|\bal\b", "aluminium"),
    (r"steel|stainless", "steel"),
    (r"foam|cellular|gas[- ]?injected", "other"),
    (r"ptfe|teflon|\bfep\b|\bpfa\b|\betfe\b|fluoro", "other"),
    (r"polyimide|kapton", "other"),
    (r"polyester|\bpet\b|mylar", "other"),
    (r"\bpvc\b|polyvinyl|vinyl", "other"),
    (r"xlpe|\bpe\b|\bhdpe\b|\bldpe\b|polyethyl|polythene", "other"),
    (r"silicone", "other"),
    (r"polyurethane|\bpur\b|\btpu\b", "other"),
    (r"\btpe\b|\btpr\b|rubber|epdm|neoprene|chloroprene|elastomer|santoprene", "other"),
    (r"polypropylene|\bpp\b", "other"),
    (r"nylon|polyamide", "other"),
    (r"paper", "other"),
    (r"cotton|textile|fibre|fiber|yarn|aramid|kevlar|glass|cord|braid(ed)? (yarn|thread)", "other"),
]


def classify_material(material):
    """Metal family name, 'other' (a recognised non-metal), 'unrecognized' or 'unrecorded'."""
    if material is None or material.strip() == "":
        return "unrecorded"
    text = material.lower()
    for pattern, family in _RULES:
        if re.search(pattern, text):
            return family
    return "unrecognized"


def _parse_one(raw):
    text = raw.strip().lower()
    if _HEX.match(text):
        return text, False
    short = _SHORT.match(text)
    if short:
        a, b, c = short.groups()
        return f"#{a}{a}{b}{b}{c}{c}", False
    named = NAMED_COLORS.get(text)
    return (named, True) if named else None


def resolve_color(raw):
    if raw is None or raw.strip() == "":
        return None
    parts = raw.split("/")
    if len(parts) > 2:
        return None
    base = _parse_one(parts[0])
    stripe = _parse_one(parts[1]) if len(parts) == 2 else None
    if base is None or (len(parts) == 2 and stripe is None):
        return None
    return {
        "hex": base[0],
        "named": base[1] or (stripe[1] if stripe else False),
        "stripe": stripe[0] if stripe else None,
    }


def appearance_of(kind, color, material):
    family = classify_material(material)
    is_metal, typical = _FAMILY.get(family, (False, None))
    conductive = kind in ("conductor", "drain", "shield")
    unspecified = family in ("unrecorded", "unrecognized")
    metal_like = (
        is_metal
        or (conductive and unspecified and kind != "shield")
        or (kind == "shield" and unspecified)
    )
    resolved = resolve_color(color)
    stripe = None
    if resolved is not None:
        base = resolved["hex"]
        source = "conventional-name" if resolved["named"] else "recorded"
        stripe = resolved["stripe"]
    elif is_metal and typical:
        base, source = typical, "material-typical"
    elif metal_like:
        base, source = "#a9afb6", "kind-neutral"
    else:
        base, source = UNKNOWN_FILL, "unknown"
    return {"base": base, "fill_source": source, "stripe": stripe}


def _channels(hexcolor):
    return [int(hexcolor[i : i + 2], 16) for i in (1, 3, 5)]


def mix_hex(a, b, t):
    x, y = _channels(a), _channels(b)
    return "#" + "".join(f"{_round(v + (w - v) * t):02x}" for v, w in zip(x, y, strict=True))


def luminance(hexcolor):
    def lin(v):
        s = v / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(v) for v in _channels(hexcolor))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def edge_color(hexcolor):
    if luminance(hexcolor) < 0.02:
        return mix_hex(hexcolor, "#ffffff", 0.45)
    return mix_hex(hexcolor, "#000000", 0.5)


# ------------------------------------------------------------------ stock section layout


def section_layout(stock):
    """Ring features, label-free: the parts of `sectionLayout` the formboard reads.

    `stock` is the canonical stock specification (a dict). Returns the ring features and
    the overall width/height, which are None unless every element has known geometry.
    """
    features = []
    unknown = []

    def visit(node, path, x, y):
        px = None if x is None else x + node["x_mm"]
        py = None if y is None else y + node["y_mm"]
        if node["kind"] == "group":
            members = [c for c in node["children"] if c["kind"] in ("group", "conductor")]
            arranged = node["arrangement"] != "concentric"
            if arranged and node["pitch_mm"] is None:
                unknown.append(f"{path}: arrangement pitch unknown")
            for child in node["children"]:
                index = members.index(child) if child in members else -1
                dx = dy = 0.0
                placed = arranged and index >= 0
                located = not (placed and node["pitch_mm"] is None)
                if placed and node["pitch_mm"] is not None:
                    if node["arrangement"] == "ring":
                        step = (
                            (-1 if node["direction"] == "ccw" else 1) * 2 * math.pi / len(members)
                        )
                        angle = -math.pi / 2 + step * index
                        dx = node["pitch_mm"] / 2 * math.cos(angle)
                        dy = node["pitch_mm"] / 2 * math.sin(angle)
                    else:
                        dx = (index - (len(members) - 1) / 2) * node["pitch_mm"]
                visit(
                    child,
                    f"{path}.{child['id']}",
                    px + dx if located and px is not None else None,
                    py + dy if located and py is not None else None,
                )
            return
        if px is None or py is None:
            unknown.append(f"{path}: position unknown")
            return
        if node["kind"] == "web":
            if node["width_mm"] is None or node["height_mm"] is None:
                unknown.append(f"{path}: web dimensions unknown")
            else:
                features.append(
                    {
                        "kind": "web",
                        "x": px,
                        "y": py,
                        "color": node["color"],
                        "material": node["material"],
                        "ring": None,
                        "rx": node["width_mm"] / 2,
                        "ry": node["height_mm"] / 2,
                    }
                )
        elif node["outer_diameter_mm"] is None or node["inner_diameter_mm"] is None:
            unknown.append(f"{path}: layer dimensions unknown")
        elif (
            node["outer_diameter_mm"] <= 0
            or node["inner_diameter_mm"] < 0
            or node["inner_diameter_mm"] >= node["outer_diameter_mm"]
        ):
            unknown.append(f"{path}: invalid layer boundaries")
        else:
            r = node["outer_diameter_mm"] / 2
            features.append(
                {
                    "kind": node["kind"],
                    "x": px,
                    "y": py,
                    "color": node["color"],
                    "material": node["material"],
                    "ring": r,
                    "rx": r,
                    "ry": r,
                }
            )

    visit(stock["structure"], stock["structure"]["id"], 0, 0)
    complete = not unknown and bool(features)
    width = height = None
    if complete:
        width = max(f["x"] + f["rx"] for f in features) - min(f["x"] - f["rx"] for f in features)
        height = max(f["y"] + f["ry"] for f in features) - min(f["y"] - f["ry"] for f in features)
    return {"features": features, "width_mm": width, "height_mm": height}


# ------------------------------------------------------------------ formboard layout


def parse_decimal(text):
    if text is None:
        return None
    m = re.fullmatch(r"(\d+)(?:\.(\d+))?", text.strip())
    if not m or len(m.group(2) or "") > 9:
        return None
    return int(m.group(1) + (m.group(2) or "")), len(m.group(2) or "")


def _other(end):
    return "b" if end == "a" else "a"


@dataclass
class Bar:
    section_id: str
    stock_revision_id: str
    stock_name: str
    x0: float
    x1: float
    y: float
    thickness: float
    length_text: str
    length_known: bool
    outer_mm: float | None
    look: dict
    ends: list


@dataclass
class Formboard:
    bars: list = field(default_factory=list)
    junctions: list = field(default_factory=list)
    links: list = field(default_factory=list)
    stubs: list = field(default_factory=list)
    bounds: dict = field(default_factory=dict)
    font_size: float = 0
    row_height: float = 0
    notes: list = field(default_factory=list)


def formboard_layout(harness, stocks, row_height=16, font_size=3.2):
    """`harness` is the canonical harness content; `stocks` maps revision id to
    {"name": str, "section": section_layout(...)}. Row height and font size are the
    fixed print sizes of the browser print path."""
    notes = []
    segments = {s["local_id"]: s for s in harness["segments"]}
    known = []
    for section in harness["sections"]:
        parsed = parse_decimal(section["planned_cut_length_mm"])
        known.append(None if parsed is None else parsed[0] / 10 ** parsed[1])
    max_known = max([0, *[v for v in known if v is not None and v > 0]])
    placeholder = max_known * 0.12 if max_known > 0 else 100
    row_h = row_height
    fs = font_size

    def outer_of(rid):
        sec = (stocks.get(rid) or {}).get("section")
        if sec and sec["width_mm"] is not None and sec["height_mm"] is not None:
            return max(sec["width_mm"], sec["height_mm"])
        return None

    max_od = max([0, *[outer_of(s["stock_revision_id"]) or 0 for s in harness["sections"]]])

    edges = []
    stub_in = []
    for b in harness["breakouts"]:
        trunk_seg = segments.get(b["trunk"]["segment_id"])
        trunk_section = trunk_seg["section_id"] if trunk_seg else None
        if not trunk_section:
            notes.append(
                f"{b['local_id']}: trunk segment {b['trunk']['segment_id']} is not in the harness"
            )
            continue
        for leg in b["legs"]:
            seg = segments.get(leg["segment_id"])
            if not seg:
                notes.append(
                    f"{b['local_id']}: leg segment {leg['segment_id']} is not in the harness"
                )
                continue
            if seg["section_id"] == trunk_section:
                stub_in.append(
                    {
                        "breakout": b["local_id"],
                        "section": trunk_section,
                        "end": b["trunk"]["end"],
                        "label": seg["label"] or seg["local_id"],
                    }
                )
            else:
                edges.append(
                    {
                        "breakout": b["local_id"],
                        "from": trunk_section,
                        "from_end": b["trunk"]["end"],
                        "to": seg["section_id"],
                        "to_end": leg["end"],
                    }
                )
    sections = {s["local_id"]: (s, known[i]) for i, s in enumerate(harness["sections"])}
    incoming = {e["to"] for e in edges}
    bars, links, junctions, stub_out = [], [], [], []
    done = set()
    next_row = [0]

    def end_labels(section_id):
        result = {}
        sec = sections[section_id][0]
        for phys in sec.get("physical_ends") or []:
            ep = next(
                (e for e in harness["endpoints"] if e["local_id"] == phys["endpoint_id"]), None
            )
            text = f"{phys['label'] or phys['local_id']}" + (
                f" → endpoint {ep['label'] or ep['local_id']}" if ep else ""
            )
            for se in phys["segment_ends"]:
                seg = segments.get(se["segment_id"])
                if seg and seg["section_id"] == section_id:
                    result.setdefault(se["end"], []).append(text)
        return result

    def place(sid, start_x, direction, start_end, row):
        if sid in done:
            return
        done.add(sid)
        s, mm = sections[sid]
        stock = stocks.get(s["stock_revision_id"])
        length = mm if mm is not None and mm > 0 else placeholder
        end_x = start_x + direction * length
        y = row * row_h
        od = outer_of(s["stock_revision_id"])
        thickness = (
            row_h * 0.22 * (max(0.45, od / max_od) if od is not None and max_od > 0 else 0.7)
        )
        rings = [
            f for f in (stock["section"]["features"] if stock else []) if f["ring"] is not None
        ]
        rings.sort(key=lambda f: -f["ring"])
        outer = rings[0] if rings else None
        look = (
            appearance_of(outer["kind"], outer["color"], outer["material"])
            if outer
            else appearance_of("jacket", None, None)
        )
        labels = end_labels(sid)
        bars.append(
            Bar(
                sid,
                s["stock_revision_id"],
                stock["name"] if stock else s["stock_revision_id"],
                min(start_x, end_x),
                max(start_x, end_x),
                y,
                thickness,
                f"{s['planned_cut_length_mm']} mm"
                if mm is not None and mm > 0
                else "length unknown",
                mm is not None and mm > 0,
                od,
                look,
                [
                    {
                        "end": start_end,
                        "x": start_x,
                        "y": y,
                        "dir": -direction,
                        "labels": labels.get(start_end, []),
                    },
                    {
                        "end": _other(start_end),
                        "x": end_x,
                        "y": y,
                        "dir": direction,
                        "labels": labels.get(_other(start_end), []),
                    },
                ],
            )
        )
        out = [e for e in edges if e["from"] == sid]
        by_breakout = {}
        for e in out:
            by_breakout.setdefault(e["breakout"], []).append(e)
        for index, e in enumerate(out):
            if e["to"] in done or e["to"] not in sections:
                continue
            at_far = e["from_end"] != start_end
            jx = end_x if at_far else start_x
            child_dir = direction if at_far else -direction
            if at_far and index == 0:
                child_row = row
            else:
                child_row = next_row[0]
                next_row[0] += 1
            place(e["to"], jx, child_dir, e["to_end"], child_row)
            placed = next((bar for bar in bars if bar.section_id == e["to"]), None)
            if placed and placed.y != y:
                links.append(
                    {"breakout": e["breakout"], "x1": jx, "y1": y, "x2": jx, "y2": placed.y}
                )
        for breakout, lst in by_breakout.items():
            jx = start_x if lst[0]["from_end"] == start_end else end_x
            junctions.append({"breakout": breakout, "x": jx, "y": y, "leg_count": len(lst)})
        mine = [t for t in stub_in if t["section"] == sid]
        for i, t in enumerate(mine):
            jx = start_x if t["end"] == start_end else end_x
            away = -direction if t["end"] == start_end else direction
            stub_out.append(
                {
                    "breakout": t["breakout"],
                    "section": sid,
                    "x": jx,
                    "y": y + (i + 1 - (len(mine) + 1) / 2 + 0.5) * row_h * 0.28 + row_h * 0.35,
                    "dir": away,
                    "labels": [t["label"]],
                }
            )

    for s, _ in sections.values():
        if s["local_id"] in incoming or s["local_id"] in done:
            continue
        row = next_row[0]
        next_row[0] += 1
        place(s["local_id"], 0, 1, "a", row)
    unplaced = []
    for s, _ in sections.values():
        if s["local_id"] in done:
            continue
        row = next_row[0]
        next_row[0] += 1
        place(s["local_id"], 0, 1, "a", row)
        unplaced.append(s["local_id"])
    if unplaced:
        notes.append(
            f"Sections {', '.join(unplaced)} are joined in a loop of breakouts; "
            "the board starts the loop at its first section."
        )
    xs = [
        *[v for b in bars for v in (b.x0, b.x1)],
        *[s["x"] + s["dir"] * row_h * 0.8 for s in stub_out],
    ]
    ys = [b.y for b in bars]
    bounds = {
        "min_x": min(0, *xs),
        "max_x": max(1, *xs),
        "min_y": min(0, *ys) - row_h * 0.6,
        "max_y": max(0, *ys) + row_h * 0.9,
    }
    return Formboard(bars, junctions, links, stub_out, bounds, fs, row_h, notes)


# ------------------------------------------------------------------ board body (print path)


def render_body(board, id_prefix="pr"):
    """Drawing content in board units without an enclosing svg (no scale bar, no selection)."""
    fs = board.font_size
    pad = fs * 14
    b = board.bounds
    vx = b["min_x"] - pad
    vy = b["min_y"] - fs * 1.5
    vw = b["max_x"] - b["min_x"] + 2 * pad
    vh = b["max_y"] - b["min_y"] + fs * 6
    i = id_prefix
    defs = (
        f'<linearGradient id="{i}-tube" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" '
        f'stop-opacity="0.55"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/><stop offset="1" '
        f'stop-color="#000" stop-opacity="0.4"/></linearGradient>'
        f'<pattern id="{i}-unk" patternUnits="userSpaceOnUse" width="{n2(fs * 0.5)}" height="{n2(fs * 0.5)}">'
        f'<path d="M0 {n2(fs * 0.5)}L{n2(fs * 0.5)} 0" stroke="#3d444b" stroke-width="{n2(fs * 0.07)}"/></pattern>'
    )
    parts = []
    for link in board.links:
        parts.append(
            f'<path data-link="{esc(link["breakout"])}" d="M{n2(link["x1"])} {n2(link["y1"])}V{n2(link["y2"])}" '
            f'stroke="currentColor" stroke-width="{n2(fs * 0.12)}" fill="none"/>'
        )
    for bar in board.bars:
        h = bar.thickness
        y = bar.y - h / 2
        w = bar.x1 - bar.x0
        edge = edge_color(bar.look["base"])
        dash = "" if bar.length_known else f' stroke-dasharray="{n2(fs * 0.5)} {n2(fs * 0.3)}"'
        stripe = ""
        if bar.look["stripe"]:
            stripe = (
                f'<rect x="{n2(bar.x0)}" y="{n2(bar.y - h * 0.12)}" width="{n2(w)}" height="{n2(h * 0.24)}" '
                f'fill="{bar.look["stripe"]}"/>'
            )
        rect = f'x="{n2(bar.x0)}" y="{n2(y)}" width="{n2(w)}" height="{n2(h)}" rx="{n2(h * 0.45)}"'
        text = (
            f'<g data-section="{esc(bar.section_id)}" data-fill-source="{bar.look["fill_source"]}" '
            f'data-length-known="{"true" if bar.length_known else "false"}">'
            f'<rect {rect} fill="{bar.look["base"]}"/>'
        )
        if bar.look["fill_source"] == "unknown":
            text += f'<rect {rect} fill="url(#{i}-unk)"/>'
        text += stripe
        text += f'<rect {rect} fill="url(#{i}-tube)" stroke="{edge}" stroke-width="{n2(fs * 0.1)}"{dash}/>'
        mid = n2((bar.x0 + bar.x1) / 2)
        text += (
            f'<text x="{mid}" y="{n2(y - fs * 0.45)}" font-size="{n2(fs)}" text-anchor="middle" '
            f'fill="currentColor">{esc(bar.section_id)} · {esc(bar.length_text)}</text>'
            f'<text x="{mid}" y="{n2(y + h + fs * 1.15)}" font-size="{n2(fs * 0.85)}" text-anchor="middle" '
            f'fill="currentColor" fill-opacity="0.75">{esc(bar.stock_name)}'
            + (f" · Ø {n2(bar.outer_mm)} mm" if bar.outer_mm is not None else "")
            + "</text>"
        )
        parts.append(text)
        for e in bar.ends:
            anchor = "start" if e["dir"] > 0 else "end"
            parts.append(
                f'<text x="{n2(e["x"] + e["dir"] * fs * 0.4)}" y="{n2(bar.y + fs * 0.35)}" font-size="{n2(fs)}" '
                f'font-weight="600" text-anchor="{anchor}" fill="currentColor">{e["end"].upper()}</text>'
            )
            for k, label in enumerate(e["labels"]):
                parts.append(
                    f'<text data-end-label="{e["end"]}" x="{n2(e["x"] + e["dir"] * fs * 1.7)}" '
                    f'y="{n2(bar.y + fs * 0.35 + k * fs * 1.1)}" font-size="{n2(fs * 0.85)}" '
                    f'text-anchor="{anchor}" fill="currentColor">{esc(label)}</text>'
                )
        parts.append("</g>")
    for s in board.stubs:
        x2 = s["x"] + s["dir"] * board.row_height * 0.7
        anchor = "start" if s["dir"] > 0 else "end"
        parts.append(
            f'<g data-stub="{esc(s["breakout"])}"><path d="M{n2(s["x"])} {n2(s["y"])}L{n2(x2)} {n2(s["y"])}" '
            f'stroke="currentColor" stroke-width="{n2(fs * 0.14)}" stroke-dasharray="{n2(fs * 0.35)} {n2(fs * 0.25)}" '
            f'fill="none"/><text x="{n2(x2 + s["dir"] * fs * 0.3)}" y="{n2(s["y"] + fs * 0.32)}" '
            f'font-size="{n2(fs * 0.85)}" text-anchor="{anchor}" fill="currentColor">'
            f"{esc(', '.join(s['labels']))} (length not recorded)</text></g>"
        )
    for j in board.junctions:
        parts.append(
            f'<g data-junction="{esc(j["breakout"])}"><circle cx="{n2(j["x"])}" cy="{n2(j["y"])}" r="{n2(fs * 0.55)}" '
            f'style="fill:var(--sb-surface-canvas,#fff);stroke:currentColor" stroke-width="{n2(fs * 0.12)}"/>'
            f'<text x="{n2(j["x"])}" y="{n2(j["y"] - fs * 0.9)}" font-size="{n2(fs * 0.85)}" text-anchor="middle" '
            f'fill="currentColor">{esc(j["breakout"])}</text></g>'
        )
    return {"defs": defs, "parts": parts, "view": {"x": vx, "y": vy, "w": vw, "h": vh + fs * 3}}


# ------------------------------------------------------------------ print plan

PAPERS = {
    "a4": (210, 297),
    "a3": (297, 420),
    "letter": (215.9, 279.4),
    "tabloid": (279.4, 431.8),
}
RULER_MM = 100
FOOTER_MM = 22
MAX_PAGES = 64
MIN_SAFE_MARGIN_MM = 5
FOOTER_FONT_MM = 2.3
DEFAULT_SETTINGS = {
    "paper": "a4",
    "orientation": "landscape",
    "margin_mm": 10,
    "overlap_mm": 10,
    "mode": "actual",
    "ratio_denominator": 2,
    "measured_ruler_mm": None,
}


def _scale_text(scale):
    if scale == 1:
        return "1:1"
    return f"1:{n3(_round((1 / scale) * 100) / 100)}"


def _sig_floor(v, digits=4):
    p = 10 ** (digits - 1 - math.floor(math.log10(v)))
    return math.floor(v * p) / p


def plan_print(board, title, **overrides):
    settings = {**DEFAULT_SETTINGS, **overrides}
    pw, ph = PAPERS[settings["paper"]]
    page_w, page_h = (ph, pw) if settings["orientation"] == "landscape" else (pw, ph)
    warnings = []

    def fail(code, text):
        warnings.append({"code": code, "severity": "error", "text": text})

    margin = settings["margin_mm"]
    win_w = page_w - 2 * margin
    win_h = page_h - 2 * margin - FOOTER_MM
    measured = settings["measured_ruler_mm"]
    factor = 1
    if measured is not None:
        if not 80 <= measured <= 120:
            fail("calibration-invalid", f"A measured ruler of {js(measured)} mm is not plausible.")
        else:
            factor = RULER_MM / measured
            if abs(measured - RULER_MM) / RULER_MM > 0.01:
                warnings.append(
                    {
                        "code": "calibration-printer-scaling",
                        "severity": "warn",
                        "text": f"The printer scaled the ruler by {n3((measured / RULER_MM - 1) * 100)}%.",
                    }
                )
    if not margin >= 0 or margin * 2 >= min(page_w, page_h):
        fail("margin-invalid", "The margin must be zero or more and leave a printable area.")
    elif margin < MIN_SAFE_MARGIN_MM:
        warnings.append(
            {
                "code": "margin-unprintable",
                "severity": "warn",
                "text": f"A margin below {MIN_SAFE_MARGIN_MM} mm is outside the printable area of most printers.",
            }
        )
    mode = settings["mode"]
    if mode == "ratio" and not 1 <= settings["ratio_denominator"] <= 1000:
        fail("ratio-invalid", "The scale must be a reduction of 1:1 to 1:1000.")
    if win_w < RULER_MM * factor + 10 or win_h < 40:
        fail(
            "page-too-small",
            "The printable area is too small for the calibration ruler and a drawing.",
        )
    overlap = settings["overlap_mm"]
    overlap_ok = overlap >= 0 and overlap * 2 < min(win_w, win_h)
    if not overlap_ok:
        fail(
            "overlap-invalid",
            "The tile overlap must be zero or more and under half of the printable area.",
        )

    body = render_body(board)
    view = body["view"]
    known = [b for b in board.bars if b.length_known]
    unknown = len(board.bars) - len(known)
    scale = 1
    if mode == "ratio" and all(w["code"] != "ratio-invalid" for w in warnings):
        scale = 1 / settings["ratio_denominator"]
    if mode == "fit" and win_w > 0 and win_h > 0:
        scale = min(1, _sig_floor(min(win_w / (view["w"] * factor), win_h / (view["h"] * factor))))
    k = scale * factor
    content_w, content_h = view["w"] * k, view["h"] * k
    cols = rows = 1
    if overlap_ok and all(w["severity"] != "error" for w in warnings):
        cols = (
            1
            if content_w <= win_w + 1e-9
            else math.ceil((content_w - overlap) / (win_w - overlap) - 1e-9)
        )
        rows = (
            1
            if content_h <= win_h + 1e-9
            else math.ceil((content_h - overlap) / (win_h - overlap) - 1e-9)
        )
        if cols * rows > MAX_PAGES:
            fail(
                "too-many-pages",
                f"This plan needs {cols * rows} pages (limit {MAX_PAGES}). "
                "Use a larger page, fit to one page or a reduced ratio.",
            )
    ok = all(w["severity"] != "error" for w in warnings)
    if mode == "fit" and scale < 1:
        warnings.append(
            {
                "code": "reduced-fit",
                "severity": "warn",
                "text": f"Fitted to one page at {_scale_text(scale)}: this is NOT full size.",
            }
        )
    if mode == "ratio" and scale < 1:
        warnings.append(
            {
                "code": "reduced-ratio",
                "severity": "warn",
                "text": f"Reduced scale {_scale_text(scale)}: this is NOT full size.",
            }
        )
    if cols * rows > 1 and ok:
        warnings.append(
            {
                "code": "tiled",
                "severity": "warn",
                "text": f"Tiled across {rows} x {cols} = {rows * cols} pages with {n3(overlap)} mm overlap.",
            }
        )
    if measured is None:
        warnings.append(
            {
                "code": "uncalibrated",
                "severity": "warn",
                "text": "Not calibrated: print once, measure the 100 mm ruler and enter the measured length.",
            }
        )
    if not known:
        warnings.append(
            {
                "code": "no-known-length",
                "severity": "warn",
                "text": "No section has a recorded planned cut length, so nothing on this print is a measurable length; no scale is claimed.",
            }
        )
    if unknown:
        warnings.append(
            {
                "code": "unknown-length",
                "severity": "warn",
                "text": f'{unknown} section{" is" if unknown == 1 else "s are"} drawn at a placeholder length, dashed and labelled "length unknown"; that length is not to scale.',
            }
        )
    if board.stubs:
        warnings.append(
            {
                "code": "stub-length-not-recorded",
                "severity": "info",
                "text": "Legs that share their trunk section have no recorded length and are drawn as dashed stubs.",
            }
        )
    warnings.append(
        {
            "code": "not-to-scale-across",
            "severity": "info",
            "text": "Only the length axis is to scale. Bar thickness, row spacing and text size are drawing aids, not measurements, and placement implies no routing, bonding or fit.",
        }
    )
    for note in board.notes:
        warnings.append({"code": "layout-note", "severity": "warn", "text": note})
    full_scale = ok and scale == 1 and bool(known)
    pages = []
    if ok:
        for r in range(rows):
            for c in range(cols):
                pages.append(
                    {
                        "index": r * cols + c,
                        "row": r,
                        "col": c,
                        "tx": c * (win_w - overlap),
                        "ty": r * (win_h - overlap),
                    }
                )
    references = [
        {"section_id": b.section_id, "recorded_mm": b.x1 - b.x0, "paper_mm": (b.x1 - b.x0) * k}
        for b in known
    ]
    return {
        "ok": ok,
        "settings": settings,
        "page_w": page_w,
        "page_h": page_h,
        "win_w": win_w,
        "win_h": win_h,
        "scale": scale,
        "calibration": {"measured_mm": measured, "factor": factor},
        "full_scale_claim": full_scale,
        "scale_label": _scale_text(scale) if known else "no scale (no recorded lengths)",
        "rows": rows if ok else 0,
        "cols": cols if ok else 0,
        "pages": pages,
        "references": references,
        "warnings": warnings,
        "body": body if ok else None,
        "title": title,
    }


def scale_statement(plan):
    lines = []
    if plan["full_scale_claim"]:
        lines.append(
            f'Declared scale {plan["scale_label"]} on the length axis. Print at Actual size / 100%, never "fit to page".'
        )
    elif plan["scale"] < 1:
        lines.append(f"Scale {plan['scale_label']}: NOT full size.")
    else:
        lines.append(f"{plan['scale_label']}. No full-size claim.")
    cal = plan["calibration"]
    if cal["measured_mm"] is None:
        lines.append(
            "Uncalibrated: the ruler must measure 100.0 mm; if not, measure it and enter it."
        )
    else:
        lines.append(
            f"Calibrated: measured {n3(cal['measured_mm'])} mm, correction x"
            f"{n3(_round(cal['factor'] * 10000) / 10000)}. The ruler must measure 100.0 mm."
        )
    return lines


def wrap_text(text, max_chars):
    out, line = [], ""
    for word in text.split():
        if line and len(line + " " + word) > max_chars:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    if line:
        out.append(line)
    return out


def footer_svg(plan, statement, extra):
    m = plan["settings"]["margin_mm"]
    top = plan["page_h"] - m - FOOTER_MM
    y = top + 4
    c = plan["calibration"]["factor"]
    length = RULER_MM * c
    ticks = "".join(
        f'<path d="M{n3(m + i * 10 * c)} {n3(y)}v{js(3 if i % 5 == 0 else 1.8)}" />'
        for i in range(11)
    )
    chars = max(20, math.floor((plan["page_w"] - 2 * m) / (FOOTER_FONT_MM * 0.62)))
    lines = [w for t in [*statement, *extra] for w in wrap_text(t, chars)]
    return (
        f'<g data-footer="true" stroke="#000" stroke-width="0.25" fill="none"><path d="M{n3(m)} {n3(y)}h{n3(length)}" />{ticks}</g>'
        f'<g font-family="monospace" font-size="{js(FOOTER_FONT_MM)}" fill="#000">'
        f'<text x="{n3(m)}" y="{n3(y + 6)}">0</text>'
        f'<text x="{n3(m + 50 * c)}" y="{n3(y + 6)}" text-anchor="middle">50</text>'
        f'<text x="{n3(m + length)}" y="{n3(y + 6)}" text-anchor="middle">100 mm ruler</text>'
        + "".join(
            f'<text x="{n3(m)}" y="{n3(y + 10 + i * 2.6)}">{esc(t)}</text>'
            for i, t in enumerate(lines)
        )
        + "</g>"
    )


def _cross(x, y):
    return f'<path d="M{n3(x - 2)} {n3(y)}h4M{n3(x)} {n3(y - 2)}v4" />'


def render_page_svg(plan, page):
    if not plan["ok"] or not plan["body"]:
        raise ValueError("A plan with errors has no pages.")
    s, body = plan["settings"], plan["body"]
    m = s["margin_mm"]
    k = plan["scale"] * plan["calibration"]["factor"]
    clip = f"pr-clip-{page['row']}-{page['col']}"
    x0 = y0 = m
    w, h = plan["win_w"], plan["win_h"]
    tx = m - page["tx"] - body["view"]["x"] * k
    ty = m - page["ty"] - body["view"]["y"] * k
    marks = "".join(
        _cross(x, y) for x, y in ((x0, y0), (x0 + w, y0), (x0, y0 + h), (x0 + w, y0 + h))
    )
    o = s["overlap_mm"]
    has_right, has_left = page["col"] < plan["cols"] - 1, page["col"] > 0
    has_down, has_up = page["row"] < plan["rows"] - 1, page["row"] > 0
    band = []

    def band_rect(x, y, bw, bh, label, lx, ly):
        band.append(
            f'<rect x="{n3(x)}" y="{n3(y)}" width="{n3(bw)}" height="{n3(bh)}" fill="#000" fill-opacity="0.06" '
            f'stroke="#000" stroke-width="0.2" stroke-dasharray="1.5 1"/><text x="{n3(lx)}" y="{n3(ly)}" '
            f'font-size="2.2" text-anchor="middle" font-family="monospace" fill="#000">{esc(label)}</text>'
        )

    r, c = page["row"], page["col"]
    if has_right:
        band_rect(x0 + w - o, y0, o, h, f"overlaps page {r + 1},{c + 2}", x0 + w - o / 2, y0 + 4)
    if has_left:
        band_rect(x0, y0, o, h, f"overlaps page {r + 1},{c}", x0 + o / 2, y0 + 4)
    if has_down:
        band_rect(
            x0, y0 + h - o, w, o, f"overlaps page {r + 2},{c + 1}", x0 + w / 2, y0 + h - o / 2
        )
    if has_up:
        band_rect(x0, y0, w, o, f"overlaps page {r},{c + 1}", x0 + w / 2, y0 + o / 2)
    refs = sorted(plan["references"], key=lambda ref: -ref["recorded_mm"])
    ref = refs[0] if refs else None
    title = plan["title"]
    shown = f"{title[:57]}..." if len(title) > 60 else title
    extra = [
        f"{shown} · page {page['index'] + 1} of {len(plan['pages'])} (row {r + 1}, column {c + 1} of {plan['rows']} x {plan['cols']})",
        (
            f"Reference span {ref['section_id']}: {n3(ref['recorded_mm'])} mm recorded, "
            f"{n3(_round(ref['paper_mm'] * 100) / 100)} mm on paper."
            if ref
            else "No recorded span to check."
        ),
    ]
    scale_attr = js(float(f"{k:.9g}"))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{n3(plan["page_w"])}mm" height="{n3(plan["page_h"])}mm" '
        f'viewBox="0 0 {n3(plan["page_w"])} {n3(plan["page_h"])}" data-page="{page["index"] + 1}" '
        f'data-scale="{plan["scale_label"]}" role="img" aria-label="{esc(title)} print page {page["index"] + 1} '
        f'of {len(plan["pages"])}" style="font-family:monospace">'
        f'<defs><clipPath id="{clip}"><rect x="{n3(x0)}" y="{n3(y0)}" width="{n3(w)}" height="{n3(h)}"/></clipPath>{body["defs"]}</defs>'
        f'<g clip-path="url(#{clip})" color="#000"><g data-content="true" transform="translate({n3(tx)} {n3(ty)}) '
        f'scale({scale_attr})">{"".join(body["parts"])}</g></g>'
        + "".join(band)
        + f'<g stroke="#000" stroke-width="0.25" fill="none" data-registration="true">{marks}</g>'
        + footer_svg(plan, scale_statement(plan), extra)
        + "</svg>"
    )


def render_print_html(plan):
    if not plan["ok"]:
        raise ValueError("A plan with errors has no document.")
    pw, ph = n3(plan["page_w"]), n3(plan["page_h"])
    css = (
        f"@page{{size:{pw}mm {ph}mm;margin:0}}html,body{{margin:0;padding:0;background:#fff}}"
        f".page{{width:{pw}mm;height:{ph}mm;overflow:hidden;break-after:page;page-break-after:always}}"
        ".page svg{display:block}.page:last-child{break-after:auto;page-break-after:auto}"
    )
    pages = "".join(f'<div class="page">{render_page_svg(plan, p)}</div>' for p in plan["pages"])
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{esc(plan["title"])} - print '
        f'{esc(plan["scale_label"])}</title><style>{css}</style></head><body data-scale="{esc(plan["scale_label"])}" '
        f'data-full-scale="{"true" if plan["full_scale_claim"] else "false"}">{pages}</body></html>'
    )
