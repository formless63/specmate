"""Deterministic inert SVG line drawings from already authorized scene primitives.

No native parser, general stock/coax layout, rasterizer or external resource loader.
Canonical metadata remains separate from rounded illustrative coordinates.
"""

import hashlib
import html
import math
import textwrap

from specmate.design.operations import canonical_bytes
from specmate.operations import ValidationFailed
from specmate.shared_scene.transforms import compose

MAX_SEGMENTS = 20000
MAX_BYTES = 8 * 1024 * 1024


def escaped(value):
    # XML 1.0 label text is inert. The original structured value stays in the manifest.
    text = str(value)
    valid = "".join(
        char
        if char in "\t\n\r"
        or 0x20 <= ord(char) <= 0xD7FF
        or 0xE000 <= ord(char) <= 0xFFFD
        or 0x10000 <= ord(char) <= 0x10FFFF
        else "�"
        for char in text
    )
    return html.escape(valid, quote=True)


def fmt(value):
    if not math.isfinite(value) or abs(value) > 1e9:
        raise ValidationFailed("Drawing exceeds supported finite illustration coordinates.")
    printed = f"{value:.6f}".rstrip("0").rstrip(".")
    return "0" if printed in ("", "-0") else printed


def point(matrix, value):
    return [sum(matrix[i][j] * (*value, 1)[j] for j in range(4)) for i in range(3)]


def translation(value):
    return [[1, 0, 0, value[0]], [0, 1, 0, value[1]], [0, 0, 1, value[2]], [0, 0, 0, 1]]


def rigid_inverse(matrix):
    rotation = [[matrix[j][i] for j in range(3)] for i in range(3)]
    return [
        [*rotation[i], -sum(rotation[i][j] * matrix[j][3] for j in range(3))] for i in range(3)
    ] + [[0, 0, 0, 1]]


def rotation(axis, degrees):
    cosine, sine = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    if axis == "x":
        return [[1, 0, 0, 0], [0, cosine, -sine, 0], [0, sine, cosine, 0], [0, 0, 0, 1]]
    if axis == "y":
        return [[cosine, 0, sine, 0], [0, 1, 0, 0], [-sine, 0, cosine, 0], [0, 0, 0, 1]]
    return [[cosine, -sine, 0, 0], [sine, cosine, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def opening_operator(scene, options):
    opening = options.opening
    if opening is None:
        return None
    target = next(
        (node for node in scene["nodes"] if node["address"]["path"] == opening.path), None
    )
    if target is None or target["world_transform"] is None:
        raise ValidationFailed(
            "Drawing opening requires an exact occurrence and known world frame."
        )
    frame = target["world_transform"]
    local = compose(translation(opening.pivot_local_mm), rotation(opening.axis, opening.angle_deg))
    local = compose(local, translation([-v for v in opening.pivot_local_mm]))
    return compose(compose(frame, local), rigid_inverse(frame))


def display_matrix(scene, address, matrix, options, opening):
    if matrix is None:
        return None
    path = address["path"]
    if opening is not None and path[: len(options.opening.path)] == options.opening.path:
        matrix = compose(opening, matrix)
    if options.explosion.enabled:
        branches = list(dict.fromkeys(node["address"]["path"][0] for node in scene["nodes"]))
        rank = branches.index(path[0])
        offset = [0, 0, 0]
        offset["xyz".index(options.explosion.axis)] = (
            rank - (len(branches) - 1) / 2
        ) * options.explosion.spacing_mm
        matrix = compose(translation(offset), matrix)
    for row in matrix:
        for value in row:
            fmt(value)
    return matrix


def clip_segment(a, b, section):
    if not section.enabled:
        return a, b
    index, sign = "xyz".index(section.axis), 1 if section.keep == "positive" else -1
    da, db = (a[index] - section.offset_mm) * sign, (b[index] - section.offset_mm) * sign
    if da < 0 and db < 0:
        return None
    if da >= 0 and db >= 0:
        return a, b
    fraction = da / (da - db)
    cross = [a[i] + (b[i] - a[i]) * fraction for i in range(3)]
    return (cross, b) if da < 0 else (a, cross)


def projected(value, view):
    x, y, z = value
    if view == "top":
        return [x, -y]
    if view == "front":
        return [x, -z]
    if view == "end":
        return [y, -z]
    return [(x + y) / math.sqrt(2), -(-0.8 * x + 0.8 * y + 2 * z) / math.sqrt(5.28)]


LIMITATIONS = [
    "Internal inspection illustration only; no distribution or release authorization.",
    "Fit, clearance, manufacturing and physical qualification are not evaluated.",
    "PCB outlines have unknown thickness, component envelopes and schematic correspondence.",
    "Stock axes show declared length only; full wire/coax section, installed routes "
    "and envelopes are unavailable.",
    "Native mechanical models remain inert and undrawn; missing models are never validated fit.",
    "Opening/explosion use chosen display axes/pivots, not physical hinges, motion "
    "envelopes or placement edits.",
    "Section clipping is uncapped illustrative line clipping, not native cross-section geometry.",
    "SVG coordinates round to six decimals; exact canonical matrices/pins remain in the manifest.",
    "Screen-fit output has no calibrated physical print scale.",
    "Renderer v1 supports finite display coordinates up to absolute 1e9 mm, "
    "20000 processed segments and 8 MiB per SVG/manifest; these are illustration bounds.",
]


def render_drawing(scene, options, version):
    resources = {item["geometry_id"]: item for item in scene["geometry"]}
    opening = opening_operator(scene, options)
    segments, unresolved, identities = [], [], []
    processed = 0

    def instance(address, ids, canonical):
        nonlocal processed
        matrix = display_matrix(scene, address, canonical, options, opening)
        row = {
            "address": address,
            "canonical_world_transform": canonical,
            "display_transform": matrix,
            "geometry_ids": ids,
            "drawn_segments": 0,
        }
        identities.append(row)
        for geometry_id in ids:
            resource = resources[geometry_id]
            lines = []
            if resource["type"] == "pcb_planar":
                for polygon in [*resource["outline"], *resource["cutouts"]]:
                    if len(lines) + len(polygon) > MAX_SEGMENTS:
                        raise ValidationFailed("Drawing exceeds the supported line segment limit.")
                    lines.extend(zip(polygon, [*polygon[1:], *polygon[:1]], strict=True))
                if not lines:
                    unresolved.append(
                        {"address": address, "reason": "Accepted board outline unavailable."}
                    )
            elif resource["type"] == "wire_construction":
                length = resource["length_mm"]
                if length is not None and math.isfinite(float(length)) and float(length) > 0:
                    lines = [([0, 0, 0], [float(length), 0, 0])]
                else:
                    unresolved.append(
                        {
                            "address": address,
                            "reason": "Declared length supplies no positive stock axis; "
                            "no default length.",
                        }
                    )
                unresolved.append(
                    {
                        "address": address,
                        "reason": "Stock axis only: full section/route/envelope unavailable.",
                    }
                )
            else:
                unresolved.append(
                    {
                        "address": address,
                        "reason": "Native model inert; geometry unavailable; fit not evaluated.",
                    }
                )
            if matrix is None:
                unresolved.append(
                    {
                        "address": address,
                        "reason": "Canonical world placement unknown; no position assigned.",
                    }
                )
                continue
            for a, b in lines:
                processed += 1
                if processed > MAX_SEGMENTS:
                    raise ValidationFailed("Drawing exceeds the supported line segment limit.")
                world_a, world_b = point(matrix, a), point(matrix, b)
                for value in (*world_a, *world_b):
                    fmt(value)
                clipped = clip_segment(world_a, world_b, options.section)
                if clipped is None:
                    continue
                start, end = [projected(p, options.view) for p in clipped]
                for value in (*start, *end):
                    fmt(value)
                segments.append(
                    {"address": address, "geometry_id": geometry_id, "start": start, "end": end}
                )
                row["drawn_segments"] += 1
        if not ids:
            unresolved.append({"address": address, "reason": "No supported drawable geometry."})

    for node in scene["nodes"]:
        instance(node["address"], node["geometry_ids"], node["world_transform"])
        for feature in node["features"]:
            # Feature placement never inherits a guessed containing-occurrence frame.
            if feature["geometry_id"]:
                instance(feature["address"], [feature["geometry_id"]], feature["world_transform"])

    points = [point for line in segments for point in [line["start"], line["end"]]]
    low = [min((p[i] for p in points), default=0) for i in range(2)]
    high = [max((p[i] for p in points), default=0) for i in range(2)]
    span = max(high[0] - low[0], high[1] - low[1], 20)
    margin = span * 0.05
    width = max(high[0] - low[0], span / 2) + margin * 2
    notes = [
        *LIMITATIONS,
        *(
            f"{'/'.join(node['address']['path'])}: {node['name']} ({node['kind']}); "
            f"world {node['world_status']}"
            for node in scene["nodes"]
        ),
    ]
    note_rows = [row for note in notes for row in textwrap.wrap(note, width=95)]
    if len(note_rows) > MAX_SEGMENTS:
        raise ValidationFailed("Drawing exceeds the supported annotation limit.")
    font = width / 120
    height = max(high[1] - low[1], span / 2) + margin * 3 + len(note_rows) * font * 1.5
    fmt(width)
    fmt(height)
    # Generated-only tags/attributes. No imported SVG, scripts, hrefs or external images.
    body = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" '
        f'height="{fmt(1024 * height / width)}" '
        f'viewBox="0 0 {fmt(width)} {fmt(height)}" role="img">',
        "<title>Internal scene inspection drawing</title>",
        f"<desc>{escaped(' '.join(LIMITATIONS))}</desc>",
        f'<g transform="translate({fmt(margin - low[0])} {fmt(margin - low[1])})" '
        f'fill="none" stroke="#19705b" stroke-width="{fmt(span / 800)}">',
    ]
    for line in segments:
        a, b = line["start"], line["end"]
        body.append(
            f'<line x1="{fmt(a[0])}" y1="{fmt(a[1])}" '
            f'x2="{fmt(b[0])}" y2="{fmt(b[1])}">'
            f"<title>{escaped(line['address'])} / {escaped(line['geometry_id'])}</title></line>"
        )
    body.append("</g>")
    text_y = max(high[1] - low[1], span / 2) + margin * 2
    for index, note in enumerate(note_rows):
        body.append(
            f'<text x="{fmt(margin)}" y="{fmt(text_y + index * font * 1.5)}" '
            f'font-family="monospace" font-size="{fmt(font)}">{escaped(note)}</text>'
        )
    manifest = {
        "schema_version": "1",
        "renderer_limits": {
            "absolute_display_coordinate_mm": 1e9,
            "processed_segments": MAX_SEGMENTS,
            "bytes_per_output": MAX_BYTES,
        },
        "renderer_version": version,
        "purpose": "internal_inspection",
        "scene_snapshot_id": scene["snapshot_id"],
        "scene_snapshot_sha256": scene["sha256"],
        "root": scene["root"],
        "units": scene["units"],
        "frame": scene["frame"],
        "matrix_convention": scene["matrix_convention"],
        "relationships": scene["relationships"],
        "options": options.model_dump(mode="json"),
        "qualification": scene["qualification"],
        "scale": {"svg_geometry_units": "mm", "print": "unknown_not_calibrated", "screen": "fit"},
        "limitations": LIMITATIONS,
        "instances": identities,
        "unresolved": unresolved,
        "projected_segments": segments,
        "nodes": scene["nodes"],
        "geometry_provenance": scene["geometry"],
        "source_rights": "Per-source declarations retained; no blanket redistribution grant.",
    }
    # The SVG embeds provenance without a circular output hash; sidecar hashes SVG bytes.
    body.append(f"<metadata>{escaped(canonical_bytes(manifest).decode())}</metadata></svg>")
    svg = "\n".join(body).encode()
    manifest["outputs"] = [
        {
            "path": "drawing.svg",
            "media_type": "image/svg+xml",
            "size": len(svg),
            "sha256": hashlib.sha256(svg).hexdigest(),
        }
    ]
    manifest_bytes = canonical_bytes(manifest)
    if len(svg) > MAX_BYTES or len(manifest_bytes) > MAX_BYTES:
        raise ValidationFailed("Drawing exceeds the supported output byte limit.")
    return svg, manifest_bytes
