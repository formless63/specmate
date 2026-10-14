"""Exact operator-reviewable recipe; generating it grants no execution authority."""

import hashlib

from specmate.contracts import check_package_path
from specmate.pcb.pack import IMAGE
from specmate.pcb_fabrication.native_script import ADAPTER, script

COPPER_LAYER_COUNTS = tuple(range(2, 33, 2))
NON_COPPER_LAYERS = ["F.Mask", "B.Mask", "F.SilkS", "B.SilkS", "F.Paste", "B.Paste", "Edge.Cuts"]
REPORT_PATH = "fabrication.json"
MAX_OUTPUT_BYTES = 64 * 1024**2
ARG_CHUNK = 8000


def layers_for(copper_layers):
    if copper_layers not in COPPER_LAYER_COUNTS:
        raise ValueError("Copper layer count must be an even number from 2 to 32")
    inner = [f"In{i}.Cu" for i in range(1, copper_layers - 1)]
    return ["F.Cu", *inner, "B.Cu", *NON_COPPER_LAYERS]


def gerber_name(layer):
    return "board-" + layer.replace(".", "_").replace("SilkS", "Silkscreen") + ".gbr"


def output_media(copper_layers):
    return {
        REPORT_PATH: "application/json",
        "drc.json": "application/json",
        "board-job.gbrjob": "application/json",
        **{gerber_name(layer): "application/vnd.gerber" for layer in layers_for(copper_layers)},
        "board-PTH.drl": "application/x-excellon",
        "board-NPTH.drl": "application/x-excellon",
    }


def recipe_for(board_path, rights, copper_layers=2):
    """One exact recipe per board path, rights and declared copper layer count.

    The program also applies the board's same-stem `.kicad_pro`/`.kicad_dru` companions
    from the preserved bundle when present, and records their hashes in its report.
    """
    check_package_path(board_path)
    layers_for(copper_layers)
    program = script(MAX_OUTPUT_BYTES)
    chunks = [program[i : i + ARG_CHUNK] for i in range(0, len(program), ARG_CHUNK)]
    identity = hashlib.sha256(f"{board_path}\0{rights}\0{copper_layers}".encode()).hexdigest()
    return {
        "id": f"{ADAPTER}-{copper_layers}l-{identity[:16]}",
        "image": IMAGE,
        # Keep each argument within the existing runner envelope. The program
        # fragments and the reconstruction launcher are exact trusted constants.
        "argv": [
            "/usr/bin/python3",
            "-c",
            "import sys;n=int(sys.argv[1]);program=''.join(sys.argv[2:2+n]);"
            "sys.argv=sys.argv[:1]+sys.argv[2+n:];exec(program)",
            str(len(chunks)),
            *chunks,
            f"/inputs/{board_path}",
            "/outputs",
            str(copper_layers),
        ],
        "input_mount": "/inputs",
        "output_mount": "/outputs",
        "network": "none",
        "limits": {
            "cpus": 2,
            "memory_bytes": 2 * 1024**3,
            "timeout_seconds": 900,
            "pids": 128,
            "max_output_bytes": MAX_OUTPUT_BYTES,
        },
        "outputs": [
            {"path": p, "media_type": m, "rights": rights}
            for p, m in output_media(copper_layers).items()
        ],
    }


def declared_copper_layers(recipe):
    """The copper layer count an exact stored recipe declares, or None."""
    try:
        value = int(recipe["argv"][-1])
        layers_for(value)
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return value
