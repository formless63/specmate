"""Trusted export-only program executed in the approved KiCad container.

Every refusal and native failure exits with a distinct code from ``DIAGNOSTICS`` and
writes a bounded failure report, so a failed stage names the check that failed.
"""

ADAPTER = "kicad-fabrication-v2"
UNKNOWN = 70

# Program exit code -> (check, explanation). The same table is embedded in the
# program and used by the server to explain a failed receipt's exit code.
DIAGNOSTICS = {
    10: ("tool_version", "The container does not provide the required KiCad 10.0.6."),
    11: (
        "board_format",
        "Only KiCad board format 20260206 is supported; upgrade the board in KiCad 10 "
        "and preserve the upgraded copy as a new source revision.",
    ),
    12: ("embedded_files", "Boards with embedded files (fonts, models) are unsupported."),
    13: ("board_parse", "KiCad could not load the board file."),
    14: (
        "copper_layer_count",
        "The board's copper layer count differs from the approved recipe's declared layers.",
    ),
    15: ("renamed_layers", "Renamed production layers are unsupported."),
    16: (
        "board_outline",
        "Edge.Cuts does not form a closed board outline; KiCad cannot derive the board shape.",
    ),
    17: (
        "via_type",
        "Blind, buried and micro vias need layer-pair drill files this adapter does not "
        "declare; only through vias are supported.",
    ),
    18: (
        "native_dnp",
        "Native DNP export behavior is unqualified; the original cannot be modified.",
    ),
    19: (
        "unfilled_zones",
        "Copper zones have no stored fill. Zones are exported as stored and never refilled; "
        "refill in KiCad and preserve a new source revision.",
    ),
    20: ("project_file", "The companion .kicad_pro project file is not valid JSON."),
    31: ("native_drc", "The native KiCad DRC command failed."),
    32: ("native_gerber_export", "The native KiCad Gerber export failed."),
    33: ("native_drill_export", "The native KiCad drill export failed."),
    34: ("native_timeout", "A native KiCad command exceeded its time limit."),
    40: ("missing_output", "A declared native output was not produced."),
    41: ("unexpected_output", "The native export produced undeclared files."),
    42: ("source_changed", "The source or its project files changed during export."),
    43: ("output_limit", "Native outputs exceed the recipe's byte limit."),
    UNKNOWN: ("unknown", "Unknown failure; a bounded diagnostic excerpt is retained."),
}

# Ordered (classification, lowercase stderr fragments); first match wins.
STDERR_CLASSES = [
    ("out_of_memory", ["bad_alloc", "out of memory", "cannot allocate memory"]),
    ("board_load", ["failed to load board", "error loading board", "unable to load"]),
    ("filesystem", ["permission denied", "read-only file system", "no space left"]),
    ("layer_argument", ["invalid layer", "unknown layer"]),
    ("arguments", ["unknown argument", "unrecognized", "invalid argument"]),
]

PROGRAM = r"""
import hashlib, json, os, re, shutil, subprocess, sys, traceback
from pathlib import Path

DIAGNOSTICS = __DIAGNOSTICS__
STDERR_CLASSES = __STDERR_CLASSES__
ADAPTER = __ADAPTER__
EXCERPT = 2000


class Stop(Exception):
    def __init__(self, code, detail="", native=None):
        super().__init__(code)
        self.code, self.detail, self.native = code, str(detail)[:500], native


def excerpt(text):
    text = text.decode("utf-8", "replace") if isinstance(text, bytes) else str(text)
    return text[-EXCERPT:]


def classify(returncode, stderr):
    if returncode < 0:
        return "terminated_by_signal"
    if returncode == 3:
        return "invalid_input"
    lowered = stderr.lower()
    for name, fragments in STDERR_CLASSES:
        if any(f in lowered for f in fragments):
            return name
    return "unknown"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fail(out, code, detail="", native=None):
    check, message = DIAGNOSTICS[code]
    if native is not None:
        native = dict(native, stderr_excerpt=excerpt(native.get("stderr_excerpt", "")))
    report = dict(
        format_version=2,
        adapter=ADAPTER,
        status="failed",
        code=code,
        check=check,
        message=message,
        detail=str(detail)[:500],
        native=native,
        manufacturing_approval=False,
        physical_qualification=False,
    )
    for p in out.iterdir():
        if p.is_file() and not p.is_symlink():
            p.unlink()
    (out / "fabrication.json").write_text(json.dumps(report, sort_keys=True) + "\n")
    raise SystemExit(code)


def main(source, out, declared_copper):
    os.environ.update(
        HOME="/tmp", XDG_CONFIG_HOME="/tmp/kicad-config", XDG_CACHE_HOME="/tmp/kicad-cache"
    )
    raw = source.read_bytes()
    original = hashlib.sha256(raw).hexdigest()
    import pcbnew

    if pcbnew.GetBuildVersion() != "10.0.6":
        raise Stop(10, pcbnew.GetBuildVersion())
    version = re.search(rb"\(version\s+(\d+)\)", raw[:4096])
    if not version or int(version[1]) != 20260206:
        raise Stop(11, version[1].decode() if version else "missing")
    if re.search(rb"\(embedded_files\b", raw):
        raise Stop(12)
    companions = {}
    for suffix in (".kicad_pro", ".kicad_dru"):
        path = source.with_suffix(suffix)
        if path.is_file() and not path.is_symlink():
            companions[suffix] = (path, path.read_bytes())
    if ".kicad_pro" in companions:
        try:
            json.loads(companions[".kicad_pro"][1])
        except ValueError as exc:
            raise Stop(20, type(exc).__name__)
    work = Path("/tmp/fabrication")
    work.mkdir()
    native = work / "board.kicad_pcb"
    native.write_bytes(raw)
    for suffix, (_, data) in companions.items():
        (work / ("board" + suffix)).write_bytes(data)
    try:
        board = pcbnew.LoadBoard(str(native))
    except Exception as exc:
        raise Stop(13, type(exc).__name__ + ": " + str(exc))
    if board is None:
        raise Stop(13, "LoadBoard returned no board")
    copper = board.GetCopperLayerCount()
    if copper != declared_copper:
        raise Stop(14, "board %d, recipe %d" % (copper, declared_copper))
    copper_layers = ["F.Cu"] + ["In%d.Cu" % i for i in range(1, copper - 1)] + ["B.Cu"]
    layers = copper_layers + [
        "F.Mask", "B.Mask", "F.SilkS", "B.SilkS", "F.Paste", "B.Paste", "Edge.Cuts"
    ]
    renamed = [
        pcbnew.LayerName(layer)
        for layer in board.GetEnabledLayers().Seq()
        if board.GetLayerName(layer) != pcbnew.LayerName(layer)
        and pcbnew.LayerName(layer).replace("Silkscreen", "SilkS") in layers
    ]
    if renamed:
        raise Stop(15, ", ".join(renamed))
    polygons = pcbnew.SHAPE_POLY_SET()
    if not board.GetBoardPolygonOutlines(polygons, False) or not polygons.OutlineCount():
        raise Stop(16)
    outline = dict(
        outlines=polygons.OutlineCount(),
        cutouts=sum(polygons.HoleCount(i) for i in range(polygons.OutlineCount())),
    )
    vias = [t for t in board.GetTracks() if isinstance(t, pcbnew.PCB_VIA)]
    other = sorted({str(v.GetViaType()) for v in vias} - {str(pcbnew.VIATYPE_THROUGH)})
    if other:
        raise Stop(17, "via types " + ", ".join(other))
    dnp = [fp.GetReference() for fp in board.GetFootprints() if fp.IsDNP()]
    if dnp:
        raise Stop(18, "%d footprints" % len(dnp))
    zones = list(board.Zones())
    copper_zones = [z for z in zones if not z.GetIsRuleArea()]
    unfilled = [z for z in copper_zones if not z.IsFilled()]
    if unfilled:
        raise Stop(19, "%d of %d copper zones" % (len(unfilled), len(copper_zones)))
    empty = [
        z for z in copper_zones
        if all(z.GetFilledPolysList(layer).OutlineCount() == 0
               for layer in z.GetLayerSet().Seq())
    ]
    holes = {"pth": [], "npth": []}

    def mm(value):
        return round(pcbnew.ToMM(value), 6)

    for via in vias:
        p = via.GetPosition()
        d = via.GetDrillValue()
        holes["pth"].append([mm(p.x), mm(p.y), mm(d), mm(d), 0.0])
    slots = 0
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            attr = pad.GetAttribute()
            if attr not in {pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH}:
                continue
            drill = pad.GetDrillSize()
            if drill.x <= 0 or drill.y <= 0:
                continue
            slot = pad.GetDrillShape() != pcbnew.PAD_DRILL_SHAPE_CIRCLE or drill.x != drill.y
            slots += slot
            p = pad.GetPosition()
            kind = "pth" if attr == pcbnew.PAD_ATTRIB_PTH else "npth"
            holes[kind].append(
                [mm(p.x), mm(p.y), mm(drill.x), mm(drill.y),
                 round(pad.GetOrientation().AsDegrees(), 6) if slot else 0.0]
            )
    production = {pcbnew.F_Cu, pcbnew.B_Cu, pcbnew.F_Mask, pcbnew.B_Mask,
                  pcbnew.F_SilkS, pcbnew.B_SilkS, pcbnew.F_Paste, pcbnew.B_Paste}
    production |= {board.GetLayerID(name) for name in copper_layers}
    graphics = list(board.GetDrawings()) + [
        d for fp in board.GetFootprints() for d in fp.GraphicalItems()
    ]
    graphics = [d for d in graphics if d.GetLayer() in production]
    unresolved = 0
    for item in graphics:
        if isinstance(item, (pcbnew.PCB_TEXT, pcbnew.PCB_TEXTBOX)):
            unresolved += "${" in item.GetShownText(True)
    plots = work / "plots"
    plots.mkdir()

    def run(code, args, timeout):
        try:
            p = subprocess.run(
                ["/usr/bin/kicad-cli", *args],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise Stop(34, args[0] + " " + args[1] + " " + args[2])
        if p.returncode:
            stderr = excerpt(p.stderr)
            raise Stop(code, native=dict(
                exit_code=p.returncode,
                stderr_class=classify(p.returncode, stderr),
                stderr_excerpt=stderr,
            ))

    run(31, ["pcb", "drc", "--format", "json", "--severity-all", "--units", "mm",
             "-o", str(work / "drc.json"), str(native)], 420)
    run(32, ["pcb", "export", "gerbers", "--layers", ",".join(layers), "--no-protel-ext",
             "--precision", "6", "-o", str(plots) + "/", str(native)], 300)
    run(33, ["pcb", "export", "drill", "--format", "excellon", "--drill-origin", "absolute",
             "--excellon-units", "mm", "--excellon-zeros-format", "decimal",
             "--excellon-oval-format", "alternate", "--excellon-separate-th",
             "-o", str(plots) + "/", str(native)], 180)
    names = ["board-" + l.replace(".", "_").replace("SilkS", "Silkscreen") + ".gbr"
             for l in layers]
    names += ["board-PTH.drl", "board-NPTH.drl", "board-job.gbrjob"]
    produced = {p.name for p in plots.iterdir()}
    missing = [n for n in names if n not in produced or not (plots / n).stat().st_size]
    if missing:
        raise Stop(40, ", ".join(missing))
    if produced - set(names):
        raise Stop(41, ", ".join(sorted(produced - set(names))))
    total = sum((plots / n).stat().st_size for n in names) + (work / "drc.json").stat().st_size
    if total > __MAX_OUTPUT__ - 1024 * 1024:
        raise Stop(43, str(total))
    drc = json.loads((work / "drc.json").read_bytes())
    counts = {
        k: len(drc[k]) for k in ["violations", "unconnected_items", "schematic_parity"]
    }
    if (
        sha(source) != original
        or native.read_bytes() != raw
        or any(path.read_bytes() != data for path, data in companions.values())
    ):
        raise Stop(42)
    shutil.copyfile(work / "drc.json", out / "drc.json")
    for name in names:
        shutil.copyfile(plots / name, out / name)
    files = [
        dict(path=p, sha256=sha(out / p), size=(out / p).stat().st_size)
        for p in sorted(names + ["drc.json"])
    ]
    root = Path("/inputs")

    def companion(suffix):
        if suffix not in companions:
            return None
        path, data = companions[suffix]
        return dict(path=path.relative_to(root).as_posix(),
                    sha256=hashlib.sha256(data).hexdigest())

    report = dict(
        format_version=2,
        adapter=ADAPTER,
        status="succeeded",
        tool_version="10.0.6",
        native_format_version=20260206,
        source_sha256=original,
        source_unchanged=True,
        project=companion(".kicad_pro"),
        custom_rules=companion(".kicad_dru"),
        copper_layer_count=copper,
        layers=layers,
        drill_format="excellon-mm-decimal-absolute-separated-through-g85-slots",
        drills={k: sorted(v) for k, v in holes.items()},
        features=dict(
            through_vias=len(vias),
            slots=slots,
            copper_zones=len(copper_zones),
            rule_areas=len(zones) - len(copper_zones),
            zones_refilled=False,
            copper_zones_without_stored_copper=len(empty),
            production_graphics=len(graphics),
            unresolved_text_variables=unresolved,
            **outline,
        ),
        drc_counts=counts,
        outputs=files,
        physical_qualification=False,
        manufacturing_approval=False,
        unsupported=[
            "schematic ERC/parity",
            "zone refill: stored fills are exported unchanged",
            "board-saved plot settings: fixed command-line plot options apply",
            "blind/buried/micro vias, embedded files and renamed production layers",
            "native DNP and reviewed population variants",
            "source authoring/modification and autorouting",
            "assembly BOM/placement, foreign formats and arm64",
        ],
    )
    (out / "fabrication.json").write_text(
        json.dumps(report, sort_keys=True, allow_nan=False) + "\n"
    )


out = Path(sys.argv[2])
try:
    main(Path(sys.argv[1]), out, int(sys.argv[3]))
except Stop as stop:
    fail(out, stop.code, stop.detail, stop.native)
except SystemExit:
    raise
except BaseException as exc:
    fail(out, __UNKNOWN__, type(exc).__name__,
         dict(exit_code=None, stderr_class="unknown",
              stderr_excerpt=excerpt(traceback.format_exc())))
""".strip()


def script(max_output):
    """Exact program text; any change produces a different recipe for operator review."""
    return (
        PROGRAM.replace("__DIAGNOSTICS__", repr(DIAGNOSTICS))
        .replace("__STDERR_CLASSES__", repr(STDERR_CLASSES))
        .replace("__ADAPTER__", repr(ADAPTER))
        .replace("__UNKNOWN__", repr(UNKNOWN))
        .replace("__MAX_OUTPUT__", repr(max_output))
    )
