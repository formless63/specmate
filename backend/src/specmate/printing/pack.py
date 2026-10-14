"""Exact slicer recipe for one frozen preparation; generating it grants no execution."""

import hashlib
import json

from specmate.operations import Unsupported
from specmate.printing.contracts import REGISTRY, ROLES
from specmate.printing.native_script import ADAPTER, SCRIPT

TOOL_ID = "prusaslicer-2.5.0"
TOOL = {
    "id": TOOL_ID,
    "name": "PrusaSlicer",
    "package": "prusa-slicer",
    "package_version": "2.5.0+dfsg-4",
}
MAX_OUTPUT_BYTES = 64 * 1024**2
REPORT_PATH = "slice.json"
MESH_SUFFIXES = (".stl", ".obj", ".3mf")
OUTPUTS = {
    "gcode": {"slice.gcode": "text/x.gcode"},
    "3mf": {"prepared.3mf": "model/3mf"},
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def output_media(output_format):
    return {
        REPORT_PATH: "application/json",
        "slice.log": "text/plain",
        **OUTPUTS[output_format],
    }


def number(value):
    if isinstance(value, int):
        return str(value)
    return format(value, ".6g")


def slicer_configuration(technology, profiles, supports):
    """Translate declared parameters to slicer settings.

    ``profiles`` maps role -> PrintProfile content. Returns ``(config, declared, defaults,
    missing)``: undeclared optional settings are left to the tool and listed as tool
    defaults, never written into the record as if they were declared.
    """
    if technology != "fdm":
        raise Unsupported(
            "Resin slicing has no qualified pack; resin profiles and variants are recorded "
            "without generated layer output."
        )
    known = {}
    for role in ROLES:
        for key, suggestion in profiles[role]["parameters"].items():
            if suggestion["basis"] != "unknown" and suggestion["value"] is not None:
                known[(role, key)] = suggestion["value"]
    config, declared, defaults, missing = {}, [], [], []
    for (tech, role, key), spec in sorted(REGISTRY.items()):
        if tech != technology or spec.slicer_key is None:
            continue
        name = f"{role}.{key}"
        if (role, key) not in known:
            (missing if spec.required_for_slicing else defaults).append(name)
            continue
        declared.append(name)
        if spec.slicer_key == "bed_shape":
            continue
        value = known[(role, key)]
        if spec.slicer_key == "fill_density":
            config[spec.slicer_key] = number(value) + "%"
        else:
            config[spec.slicer_key] = number(value) if spec.type != "choice" else value
    x, y = known.get(("printer", "bed_size_x_mm")), known.get(("printer", "bed_size_y_mm"))
    if x is not None and y is not None:
        x, y = number(x), number(y)
        config["bed_shape"] = f"0x0,{x}x0,{x}x{y},0x{y}"
    status = supports["status"]
    if status != "unknown":
        config["support_material"] = "0" if status == "none" else "1"
        config["support_material_auto"] = "0" if status == "none" else "1"
        config["support_material_buildplate_only"] = "1" if status == "buildplate_only" else "0"
    return config, declared, defaults, missing


def recipe_id(spec):
    return ADAPTER + "-" + hashlib.sha256(canonical(spec)).hexdigest()[:32]


def recipe_for(spec, image, rights):
    encoded = canonical(spec).decode()
    if len(encoded) > 16384:
        raise Unsupported("This exact slicer input exceeds its bounded argument envelope.")
    return {
        "id": recipe_id(spec),
        "image": image,
        "argv": ["/usr/bin/python3", "-c", SCRIPT, encoded],
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
            for p, m in output_media(spec["output_format"]).items()
        ],
    }
