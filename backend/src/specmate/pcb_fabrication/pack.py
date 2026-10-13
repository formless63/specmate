"""Exact operator-reviewable recipe; generating it grants no execution authority."""

import hashlib

from specmate.contracts import check_package_path
from specmate.pcb.pack import IMAGE
from specmate.pcb_fabrication.native_script import SCRIPT

LAYERS = [
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
REPORT_PATH = "fabrication.json"
MAX_OUTPUT_BYTES = 16 * 1024**2
OUTPUT_MEDIA = {
    REPORT_PATH: "application/json",
    "drc.json": "application/json",
    "board-job.gbrjob": "application/json",
    **{
        "board-"
        + layer.replace(".", "_").replace("SilkS", "Silkscreen")
        + ".gbr": "application/vnd.gerber"
        for layer in LAYERS
    },
    "board-PTH.drl": "application/x-excellon",
    "board-NPTH.drl": "application/x-excellon",
}


def recipe_for(board_path, rights):
    check_package_path(board_path)
    identity = hashlib.sha256(f"{board_path}\0{rights}".encode()).hexdigest()[:16]
    return {
        "id": f"kicad-fabrication-v1-{identity}",
        "image": IMAGE,
        # Keep each argument within the existing runner envelope. Both program
        # fragments and the reconstruction launcher are exact trusted constants.
        "argv": [
            "/usr/bin/python3",
            "-c",
            "import sys;program=''.join(sys.argv[1:3]);"
            "sys.argv=sys.argv[:1]+sys.argv[3:];exec(program)",
            SCRIPT[: len(SCRIPT) // 2],
            SCRIPT[len(SCRIPT) // 2 :],
            f"/inputs/{board_path}",
            "/outputs",
        ],
        "input_mount": "/inputs",
        "output_mount": "/outputs",
        "network": "none",
        "limits": {
            "cpus": 2,
            "memory_bytes": 1024**3,
            "timeout_seconds": 180,
            "pids": 128,
            "max_output_bytes": MAX_OUTPUT_BYTES,
        },
        "outputs": [
            {"path": p, "media_type": m, "rights": rights} for p, m in OUTPUT_MEDIA.items()
        ],
    }
