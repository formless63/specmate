"""Exact isolated recipe identity; generation grants no execution authority."""

import hashlib

from specmate.contracts import check_package_path
from specmate.pcb.pack import IMAGE
from specmate.pcb_disagreement.native_script import SCRIPT
from specmate.pcb_disagreement.xml_extract import ADAPTER, MAX_XML_BYTES

REPORT_PATH = "source-net-assertions.json"
XML_PATH = "source-nets.xml"


def recipe_for(source_path: str, rights: str, source_role: str) -> dict:
    check_package_path(source_path)
    if source_role not in {"schematic", "netlist"} or not 1 <= len(rights) <= 200:
        raise ValueError("Expected schematic/netlist and declared rights")
    if source_role == "schematic" and not source_path.lower().endswith(".kicad_sch"):
        raise ValueError("Expected a .kicad_sch source")
    identity = hashlib.sha256(f"{source_role}\0{source_path}\0{rights}".encode()).hexdigest()[:16]
    return {
        "id": f"{ADAPTER}-{identity}",
        "image": IMAGE,
        "argv": [
            "/usr/bin/python3",
            "-c",
            SCRIPT,
            source_role,
            f"/inputs/{source_path}",
            f"/outputs/{REPORT_PATH}",
            f"/outputs/{XML_PATH}",
        ],
        "input_mount": "/inputs",
        "output_mount": "/outputs",
        "network": "none",
        "limits": {
            "cpus": 2,
            "memory_bytes": 1024**3,
            "timeout_seconds": 120,
            "pids": 128,
            "max_output_bytes": 2 * MAX_XML_BYTES,
        },
        "outputs": [
            {"path": REPORT_PATH, "media_type": "application/json", "rights": rights},
            {"path": XML_PATH, "media_type": "application/xml", "rights": rights},
        ],
    }
