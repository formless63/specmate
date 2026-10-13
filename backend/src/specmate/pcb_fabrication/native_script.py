"""Trusted export-only program executed in the approved KiCad container."""

from textwrap import indent

PROGRAM = r"""
import hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path

os.environ.update(
    HOME="/tmp", XDG_CONFIG_HOME="/tmp/kicad-config", XDG_CACHE_HOME="/tmp/kicad-cache"
)
import pcbnew

source, out = Path(sys.argv[1]), Path(sys.argv[2])
raw = source.read_bytes()
original = hashlib.sha256(raw).hexdigest()
if pcbnew.GetBuildVersion() != "10.0.6":
    raise ValueError("Required KiCad version is 10.0.6")
version = re.search(rb"\(version\s+(\d+)\)", raw[:4096])
if not version or int(version[1]) != 20260206:
    raise ValueError("Only board format 20260206 is supported")
if b"${" in raw or re.search(rb"\(embedded_files\b", raw):
    raise ValueError("Variables and embedded assets are unsupported")
if any(
    p.suffix.lower() in {".kicad_pro", ".kicad_dru"} for p in Path("/inputs").rglob("*")
):
    raise ValueError(
        "Project rules/settings are unqualified; standalone board required"
    )
board = pcbnew.LoadBoard(str(source))
if board is None or board.GetCopperLayerCount() != 2:
    raise ValueError("Exactly two copper layers required")
layers = [
    "F.Cu",
    "B.Cu",
    "F.Mask",
    "B.Mask",
    "F.SilkS",
    "B.SilkS",
    "F.Paste",
    "B.Paste",
    "Edge.Cuts",
]
for layer in [
    pcbnew.F_Cu,
    pcbnew.B_Cu,
    pcbnew.F_Mask,
    pcbnew.B_Mask,
    pcbnew.F_SilkS,
    pcbnew.B_SilkS,
    pcbnew.F_Paste,
    pcbnew.B_Paste,
    pcbnew.Edge_Cuts,
]:
    if board.GetLayerName(layer) != pcbnew.LayerName(layer):
        raise ValueError("Renamed production layers are unsupported")
if list(board.Zones()):
    raise ValueError("Zones are unsupported; no refill or omitted copper is permitted")
if any(
    type(t) != pcbnew.PCB_TRACK or t.GetLayer() not in {pcbnew.F_Cu, pcbnew.B_Cu}
    for t in board.GetTracks()
):
    raise ValueError(
        "Only straight outer copper tracks supported; vias/arcs unsupported"
    )
edges = [d for d in board.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
edges += [
    d
    for fp in board.GetFootprints()
    for d in fp.GraphicalItems()
    if d.GetLayer() == pcbnew.Edge_Cuts
]
polygons = pcbnew.SHAPE_POLY_SET()
if (
    not edges
    or not all(
        isinstance(d, pcbnew.PCB_SHAPE) and d.GetShape() == pcbnew.SHAPE_T_SEGMENT
        for d in edges
    )
    or not board.GetBoardPolygonOutlines(polygons, False)
):
    raise ValueError(
        "Closed line outlines required; arcs/open/missing outline unsupported"
    )
if polygons.OutlineCount() != 1 or polygons.HoleCount(0):
    raise ValueError("Only one outer outline without cutouts is qualified")
production = {
    pcbnew.F_Cu,
    pcbnew.B_Cu,
    pcbnew.F_Mask,
    pcbnew.B_Mask,
    pcbnew.F_SilkS,
    pcbnew.B_SilkS,
    pcbnew.F_Paste,
    pcbnew.B_Paste,
}
graphics = list(board.GetDrawings()) + [
    d for fp in board.GetFootprints() for d in fp.GraphicalItems()
]
graphics += [field for fp in board.GetFootprints() for field in fp.GetFields()
    if field.IsVisible()]
if any(d.GetLayer() in production for d in graphics):
    raise ValueError("Production-layer graphics/text are unqualified")
holes = {"pth": [], "npth": []}
for fp in board.GetFootprints():
    if fp.IsDNP():
        raise ValueError(
            "Native DNP export behavior is unqualified; original cannot be modified"
        )
    for pad in fp.Pads():
        if pad.GetShape() not in {pcbnew.PAD_SHAPE_CIRCLE, pcbnew.PAD_SHAPE_RECTANGLE}:
            raise ValueError("Only circle/rectangle pads qualified")
        attr = pad.GetAttribute()
        drill = pad.GetDrillSize()
        if attr == pcbnew.PAD_ATTRIB_SMD:
            if drill.x or drill.y:
                raise ValueError("Unexpected SMD drill")
        elif attr in {pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH}:
            if (
                drill.x <= 0
                or drill.x != drill.y
                or pad.GetDrillShape() != pcbnew.PAD_DRILL_SHAPE_CIRCLE
            ):
                raise ValueError("Only circular through drills qualified")
            kind = "pth" if attr == pcbnew.PAD_ATTRIB_PTH else "npth"
            p = pad.GetPosition()
            holes[kind].append(
                [
                    round(pcbnew.ToMM(p.x), 6),
                    round(pcbnew.ToMM(p.y), 6),
                    round(pcbnew.ToMM(drill.x), 6),
                ]
            )
        else:
            raise ValueError("Unsupported pad attribute")
work = Path("/tmp/fabrication")
work.mkdir()
native = work / "board.kicad_pcb"
native.write_bytes(raw)
plots = work / "plots"
plots.mkdir()


def run(args):
    p = subprocess.run(
        ["/usr/bin/kicad-cli", *args],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=45,
    )
    if p.returncode:
        raise ValueError("Native command failed with exit code " + str(p.returncode))


run(
    [
        "pcb",
        "drc",
        "--format",
        "json",
        "--severity-all",
        "--units",
        "mm",
        "-o",
        str(out / "drc.json"),
        str(native),
    ]
)
run(
    [
        "pcb",
        "export",
        "gerbers",
        "--layers",
        ",".join(layers),
        "--no-protel-ext",
        "--precision",
        "6",
        "-o",
        str(plots) + "/",
        str(native),
    ]
)
run(
    [
        "pcb",
        "export",
        "drill",
        "--format",
        "excellon",
        "--drill-origin",
        "absolute",
        "--excellon-units",
        "mm",
        "--excellon-zeros-format",
        "decimal",
        "--excellon-separate-th",
        "-o",
        str(plots) + "/",
        str(native),
    ]
)
paths = ["drc.json"]
for layer in layers:
    name = "board-" + layer.replace(".", "_").replace("SilkS", "Silkscreen") + ".gbr"
    p = plots / name
    if not p.is_file() or not p.stat().st_size:
        raise ValueError("Missing declared Gerber layer")
    shutil.copyfile(p, out / name)
    paths.append(name)
for kind in ["PTH", "NPTH"]:
    name = "board-" + kind + ".drl"
    p = plots / name
    if not p.is_file() or not p.stat().st_size:
        raise ValueError("Missing declared drill file")
    shutil.copyfile(p, out / name)
    paths.append(name)
job = plots / "board-job.gbrjob"
if not job.is_file():
    raise ValueError("Missing declared Gerber job")
shutil.copyfile(job, out / job.name)
paths.append(job.name)
allowed = {p for p in paths if p != "drc.json"}
if {p.name for p in plots.iterdir()} - allowed:
    raise ValueError("Unexpected native export output")
drc = json.loads((out / "drc.json").read_bytes())
counts = {
    k: len(drc[k]) for k in ["violations", "unconnected_items", "schematic_parity"]
}
if (
    hashlib.sha256(source.read_bytes()).hexdigest() != original
    or native.read_bytes() != raw
):
    raise ValueError("Source changed during export")
files = [
    dict(
        path=p,
        sha256=hashlib.sha256((out / p).read_bytes()).hexdigest(),
        size=(out / p).stat().st_size,
    )
    for p in sorted(paths)
]
report = dict(
    format_version=1,
    adapter="kicad-fabrication-v1",
    tool_version="10.0.6",
    native_format_version=20260206,
    source_sha256=original,
    source_unchanged=True,
    layers=layers,
    drill_format="excellon-mm-decimal-absolute-separated-through",
    drills={k: sorted(v) for k, v in holes.items()},
    drc_counts=counts,
    outputs=files,
    physical_qualification=False,
    manufacturing_approval=False,
    unsupported=[
        "schematic ERC/parity",
        "production-layer graphics/text and cutouts",
        "custom project design rules",
        "zones, vias, curved tracks and outlines, slots, custom pads",
        "native DNP and reviewed population variants",
        "source authoring/modification and autorouting",
        "assembly BOM/placement, foreign formats and arm64",
    ],
)
(out / "fabrication.json").write_text(
    json.dumps(report, sort_keys=True, allow_nan=False) + "\n"
)
""".strip()

SCRIPT = (
    "try:\n"
    + indent(PROGRAM, "    ")
    + """
except Exception:
    import json,sys
    from pathlib import Path
    diagnostic={"status":"failed","error":"Unsupported input or native export failure"}
    (Path(sys.argv[2])/"fabrication.json").write_text(json.dumps(diagnostic)+"\\n")
    raise SystemExit(1)
"""
)
