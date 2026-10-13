"""Recipe identity shared by the operator generator and PCB command validation."""

import hashlib

from specmate.pcb.native_script import SCRIPT

IMAGE = "kicad/kicad:10.0.6@sha256:40568bc95527f3a673a31a9b59badf512e71046c2d5068a364503c525f946a4e"
REPORT_PATH = "pcb-intake.json"
MAX_REPORT_BYTES = 2 * 1024**2


def recipe_for(board_path: str, rights: str) -> dict:
    identity = hashlib.sha256(f"{board_path}\0{rights}".encode()).hexdigest()[:16]
    return {
        "id": f"kicad-intake-v1-{identity}",
        "image": IMAGE,
        "argv": [
            "/usr/bin/python3",
            "-c",
            SCRIPT,
            f"/inputs/{board_path}",
            f"/outputs/{REPORT_PATH}",
        ],
        "input_mount": "/inputs",
        "output_mount": "/outputs",
        "network": "none",
        "limits": {
            "cpus": 2,
            "memory_bytes": 1024**3,
            "timeout_seconds": 120,
            "pids": 128,
            "max_output_bytes": MAX_REPORT_BYTES,
        },
        "outputs": [{"path": REPORT_PATH, "media_type": "application/json", "rights": rights}],
    }
