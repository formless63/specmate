"""Independent Gerber X2 / Gerber job / Excellon checks for registered fabrication outputs.

Pure standard library: these parsers read the exported files directly and never trust
the native report's own claims. They check format declarations, per-layer X2 file
functions, job-file layer coverage, outline drawing (lines and arcs), copper regions
for stored zone fills, and Excellon round hits and G85 slots against declared holes.
"""

import json
import math
import re
from collections import Counter
from pathlib import Path

ROUND = 3  # Excellon decimal millimetres carry three decimals.
FUNCTIONS = {
    "F.Mask": ("Soldermask,Top", "SolderMask,Top"),
    "B.Mask": ("Soldermask,Bot", "SolderMask,Bot"),
    "F.SilkS": ("Legend,Top", "Legend,Top"),
    "B.SilkS": ("Legend,Bot", "Legend,Bot"),
    "F.Paste": ("Paste,Top", "SolderPaste,Top"),
    "B.Paste": ("Paste,Bot", "SolderPaste,Bot"),
    "Edge.Cuts": ("Profile,NP", "Profile"),
}


def gerber_name(layer):
    return "board-" + layer.replace(".", "_").replace("SilkS", "Silkscreen") + ".gbr"


def file_functions(layer, copper):
    """(Gerber X2 attribute, Gerber job attribute) for a declared layer."""
    if layer == "F.Cu":
        value = "Copper,L1,Top"
    elif layer == "B.Cu":
        value = f"Copper,L{copper},Bot"
    elif layer.startswith("In") and layer.endswith(".Cu"):
        value = f"Copper,L{int(layer[2:-3]) + 1},Inr"
    else:
        return FUNCTIONS[layer]
    return value, value


def gerber(path, layer, copper):
    text = path.read_text()
    x2, _ = file_functions(layer, copper)
    if f"%TF.FileFunction,{x2}*%" not in text:
        raise ValueError(f"{path.name}: X2 file function differs from {x2}")
    if "%FSLAX46Y46*%" not in text or "%MOMM*%" not in text:
        raise ValueError(f"{path.name}: Gerber precision/units differ")
    if not text.rstrip().endswith("M02*"):
        raise ValueError(f"{path.name}: Gerber file is not terminated")
    return {
        "draws": len(re.findall(r"D01\*", text)),
        "arcs": len(re.findall(r"^X-?\d+Y-?\d+I-?\d+J-?\d+D01\*$", text, re.MULTILINE)),
        "regions": text.count("G36*"),
    }


def excellon(path):
    """Round hits {(x, y, d)} and slots [(x1, y1, x2, y2, d)] in output coordinates."""
    tools, tool, hits, slots = {}, None, Counter(), []
    header = True
    for line in path.read_text().splitlines():
        if line.startswith(";") or not line:
            continue
        if header:
            m = re.fullmatch(r"T(\d+)C(\d+(?:\.\d+)?)", line)
            if m:
                tools[m[1]] = float(m[2])
            elif line == "%":
                header = False
            elif line not in {"M48", "FMAT,2", "METRIC"}:
                raise ValueError(f"{path.name}: unexpected header line {line!r}")
            continue
        n = r"(-?\d+(?:\.\d+)?)"
        if re.fullmatch(r"T(\d+)", line):
            tool = tools[line[1:]]
        elif m := re.fullmatch(f"X{n}Y{n}G85X{n}Y{n}", line):
            slots.append((*map(float, m.groups()), tool))
        elif m := re.fullmatch(f"X{n}Y{n}", line):
            hits[(float(m[1]), float(m[2]), tool)] += 1
        elif line not in {"G90", "G05", "M30", "T0"}:
            raise ValueError(f"{path.name}: unexpected drill line {line!r}")
    if "METRIC" not in path.read_text():
        raise ValueError(f"{path.name}: drill units differ")
    return hits, slots


def r(value):
    return round(value + 0.0, ROUND)


def expected_holes(declared):
    """Declared native holes [x, y, sx, sy, rot] in output coordinates (Y negated)."""
    hits, slots = Counter(), []
    for x, y, sx, sy, rot in declared:
        if sx == sy:
            hits[(r(x), r(-y), r(sx))] += 1
            continue
        width, half = min(sx, sy), (max(sx, sy) - min(sx, sy)) / 2
        angle = math.radians(rot) + (0 if sx > sy else math.pi / 2)
        dx, dy = half * math.cos(angle), half * math.sin(angle)
        # KiCad rotation is counterclockwise on screen with Y down; output Y is negated.
        slots.append((x, -y, dx, dy, width))
    return hits, slots


def parallel(a, b):
    """Slot axis orientation agrees (either direction) within about half a degree."""
    size = math.hypot(*a) * math.hypot(*b)
    return size > 0 and abs(a[0] * b[1] - a[1] * b[0]) <= 0.01 * size


def check_drills(path, declared):
    hits, slots = excellon(path)
    want, want_slots = expected_holes(declared)
    if sum(hits.values()) != sum(want.values()):
        raise ValueError(
            f"{path.name}: independent round hit count differs from declared holes"
        )
    for (x, y, d), count in hits.items():
        # KiCad rounds nanometre positions to three decimals; allow one unit of rounding.
        for _ in range(count):
            key = next(
                (
                    (r(x + i / 1000), r(y + j / 1000), r(d))
                    for i in (0, -1, 1)
                    for j in (0, -1, 1)
                    if want[(r(x + i / 1000), r(y + j / 1000), r(d))] > 0
                ),
                None,
            )
            if key is None:
                raise ValueError(f"{path.name}: hit at {x},{y} has no declared hole")
            want[key] -= 1
    if len(slots) != len(want_slots):
        raise ValueError(f"{path.name}: independent slot count differs")
    remaining = list(want_slots)
    for x1, y1, x2, y2, d in slots:
        cx, cy, half = (x1 + x2) / 2, (y1 + y2) / 2, math.dist((x1, y1), (x2, y2)) / 2
        match = next(
            (
                s
                for s in remaining
                if abs(s[0] - cx) <= 0.002
                and abs(s[1] - cy) <= 0.002
                and abs(math.hypot(s[2], s[3]) - half) <= 0.002
                and abs(s[4] - d) <= 0.002
                and parallel((x2 - x1, y2 - y1), (s[2], s[3]))
            ),
            None,
        )
        if match is None:
            raise ValueError(
                f"{path.name}: slot at {cx:.3f},{cy:.3f} has no declared hole"
            )
        remaining.remove(match)
    return {"round_hits": sum(hits.values()), "slots": len(slots)}


def check_outputs(directory, report):
    """Check one complete output directory against a parsed success report."""
    directory = Path(directory)
    copper = report["copper_layer_count"]
    layers = report["layers"]
    summary = {"layers": {}}
    for layer in layers:
        summary["layers"][layer] = gerber(directory / gerber_name(layer), layer, copper)
    job = json.loads((directory / "board-job.gbrjob").read_bytes())
    if job["GeneralSpecs"]["LayerNumber"] != copper:
        raise ValueError("Gerber job copper layer count differs")
    attributes = {f["Path"]: f["FileFunction"] for f in job["FilesAttributes"]}
    expected = {
        gerber_name(layer): file_functions(layer, copper)[1] for layer in layers
    }
    if attributes != expected:
        raise ValueError("Gerber job does not reference every exact declared layer")
    edge = summary["layers"]["Edge.Cuts"]
    if not edge["draws"]:
        raise ValueError("Board outline Gerber draws nothing")
    features = report["features"]
    filled = features["copper_zones"] - features["copper_zones_without_stored_copper"]
    copper_regions = sum(
        summary["layers"][layer]["regions"] for layer in layers[:copper]
    )
    if filled and not copper_regions:
        raise ValueError("Stored zone fills are missing from every copper Gerber")
    for kind in ("pth", "npth"):
        name = f"board-{kind.upper()}.drl"
        summary[kind] = check_drills(directory / name, report["drills"][kind])
    if summary["pth"]["slots"] + summary["npth"]["slots"] != features["slots"]:
        raise ValueError("Independent slot count differs from the report")
    pth_rounds = sum(1 for h in report["drills"]["pth"] if h[2] == h[3])
    if pth_rounds < features["through_vias"]:
        raise ValueError("Plated drill file holds fewer holes than through vias")
    summary["outline_arcs"] = edge["arcs"]
    summary["copper_regions"] = copper_regions
    return summary
