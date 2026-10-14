"""Exact slicer recipe for one frozen preparation; generating it grants no execution."""

import hashlib
import json

from specmate.operations import Unsupported
from specmate.printing import orca_script, uvtools_script
from specmate.printing.contracts import ORCA_TOOL_ID, REGISTRY, ROLES
from specmate.printing.native_script import ADAPTER, SCRIPT

TOOL_ID = "prusaslicer-2.5.0"
TOOL = {
    "id": TOOL_ID,
    "name": "PrusaSlicer",
    "package": "prusa-slicer",
    "package_version": "2.5.0+dfsg-4",
}
# The upstream release asset and its GitHub release digest; the image records both.
ORCA_TOOL = {
    "id": ORCA_TOOL_ID,
    "name": "OrcaSlicer",
    "package": "OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage",
    "package_version": "2.4.2",
    "release_sha256": "sha256:d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd",
}
TOOLS = {TOOL_ID: TOOL, ORCA_TOOL_ID: ORCA_TOOL}
ORCA_ADAPTER = orca_script.ADAPTER
MAX_OUTPUT_BYTES = 64 * 1024**2
REPORT_PATH = "slice.json"
MESH_SUFFIXES = (".stl", ".obj", ".3mf")
# Only STL input is exercised with the real OrcaSlicer image.
ORCA_MESH_SUFFIXES = (".stl",)
OUTPUTS = {
    "gcode": {"slice.gcode": "text/x.gcode"},
    "3mf": {"prepared.3mf": "model/3mf"},
}
# OrcaSlicer always yields plate G-code; "3mf" adds the project with that G-code embedded
# (the form Bambu Lab printers take as .gcode.3mf).
ORCA_OUTPUTS = {
    "gcode": {"slice.gcode": "text/x.gcode"},
    "3mf": {"slice.gcode": "text/x.gcode", "sliced.3mf": "model/3mf"},
}

# Bundled vendor presets exercised with the real OrcaSlicer 2.4.2 image (0.4 mm nozzles).
# Names and bundle versions only; the preset files stay inside the pinned image.
QIDI = {"tool": ORCA_TOOL_ID, "vendor": "Qidi", "bundle_version": "02.04.00.06"}
BBL = {"tool": ORCA_TOOL_ID, "vendor": "BBL", "bundle_version": "02.01.00.19"}
ORCA_PRESETS = {
    "qidi-q1-pro": {
        "label": "Qidi Q1 Pro, 0.4 mm nozzle, PLA",
        "printer": {**QIDI, "name": "Qidi Q1 Pro 0.4 nozzle"},
        "process": {**QIDI, "name": "0.20mm Standard @Qidi Q1 Pro"},
        "material": {**QIDI, "name": "QIDI PLA Basic @Qidi Q1 Pro 0.4 nozzle"},
    },
    "qidi-x-plus-4": {
        "label": "Qidi X-Plus 4, 0.4 mm nozzle, PLA",
        "printer": {**QIDI, "name": "Qidi X-Plus 4 0.4 nozzle"},
        "process": {**QIDI, "name": "0.20mm Standard @Qidi XPlus4"},
        "material": {**QIDI, "name": "QIDI PLA Basic @Qidi X-Plus 4 0.4 nozzle"},
    },
    "bambu-p1s": {
        "label": "Bambu Lab P1S, 0.4 mm nozzle, generic PLA",
        "printer": {**BBL, "name": "Bambu Lab P1S 0.4 nozzle"},
        "process": {**BBL, "name": "0.20mm Standard @BBL X1C"},
        "material": {**BBL, "name": "Generic PLA"},
    },
}

RESIN_TOOL = {
    "id": "uvtools-7.0.0",
    "name": "UVtools",
    "package": "UVtools_linux-x64_v7.0.0.zip",
    "package_version": "7.0.0",
    "release_sha256": "sha256:bcd47d2d045ff0b8489fd2f7866569521586888c636e2f17603af65a932acb76",
}
RESIN_ADAPTER = uvtools_script.ADAPTER
RESIN_SUFFIXES = uvtools_script.SUFFIXES
RESIN_REPORT_PATH = "inspect.json"
RESIN_OUTPUTS = {
    RESIN_REPORT_PATH: "application/json",
    "inspect.log": "text/plain",
    "properties.txt": "text/plain",
}
RESIN_MAX_OUTPUT_BYTES = 16 * 1024**2


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def output_media(output_format, adapter=ADAPTER):
    outputs = ORCA_OUTPUTS if adapter == ORCA_ADAPTER else OUTPUTS
    return {
        REPORT_PATH: "application/json",
        "slice.log": "text/plain",
        **outputs[output_format],
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


def orca_value(spec, value):
    text = number(value) if spec.type != "choice" else value
    if spec.slicer_key == "fill_density":
        text += "%"
    return [text] if spec.orca_vector else text


def orca_configuration(profiles, supports):
    """Overrides on top of the named vendor presets for OrcaSlicer.

    Returns ``(presets, overrides, declared, preset_settings, not_sent, missing)``.
    Undeclared parameters come from the preset (``preset_settings``); declared
    parameters without an OrcaSlicer mapping are listed in ``not_sent``.
    """
    presets, missing = {}, []
    for role in ROLES:
        preset = profiles[role].get("vendor_preset")
        if preset is None or preset["tool"] != ORCA_TOOL_ID:
            missing.append(role)
        else:
            presets[role] = {k: preset[k] for k in ("vendor", "bundle_version", "name")}
    overrides = {role: {} for role in ROLES}
    declared, preset_settings, not_sent = [], [], []
    known = {}
    for role in ROLES:
        for key, suggestion in profiles[role]["parameters"].items():
            if suggestion["basis"] != "unknown" and suggestion["value"] is not None:
                known[(role, key)] = suggestion["value"]
    for (tech, role, key), spec in sorted(REGISTRY.items()):
        if tech != "fdm":
            continue
        name = f"{role}.{key}"
        if (role, key) not in known:
            if spec.orca_keys:
                preset_settings.append(name)
            continue
        if not spec.orca_keys:
            not_sent.append(name)
            continue
        declared.append(name)
        if spec.orca_keys == ("printable_area",):
            continue
        value = known[(role, key)]
        for orca_key in spec.orca_keys:
            if orca_key == "brim_type":
                overrides[role][orca_key] = "no_brim" if value == 0 else "outer_only"
            else:
                overrides[role][orca_key] = orca_value(spec, value)
    x, y = known.get(("printer", "bed_size_x_mm")), known.get(("printer", "bed_size_y_mm"))
    if x is not None and y is not None:
        x, y = number(x), number(y)
        overrides["printer"]["printable_area"] = ["0x0", f"{x}x0", f"{x}x{y}", f"0x{y}"]
    elif (x is None) != (y is None):
        not_sent.append("printer.bed_size (needs both X and Y)")
    status = supports["status"]
    if status != "unknown":
        overrides["process"]["enable_support"] = "0" if status == "none" else "1"
        overrides["process"]["support_on_build_plate_only"] = (
            "1" if status == "buildplate_only" else "0"
        )
    return presets, overrides, declared, preset_settings, not_sent, missing


def recipe_id(spec):
    return spec["adapter"] + "-" + hashlib.sha256(canonical(spec)).hexdigest()[:32]


def recipe_for(spec, image, rights):
    encoded = canonical(spec).decode()
    if len(encoded) > 16384:
        raise Unsupported("This exact slicer input exceeds its bounded argument envelope.")
    script = orca_script.SCRIPT if spec["adapter"] == ORCA_ADAPTER else SCRIPT
    return {
        "id": recipe_id(spec),
        "image": image,
        "argv": ["/usr/bin/python3", "-c", script, encoded],
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
            for p, m in output_media(spec["output_format"], spec["adapter"]).items()
        ],
    }


def resin_recipe_id(spec):
    return RESIN_ADAPTER + "-" + hashlib.sha256(canonical(spec)).hexdigest()[:32]


def resin_recipe_for(spec, image, rights):
    """Exact UVtools inspection recipe for one pinned resin file; grants no execution."""
    return {
        "id": resin_recipe_id(spec),
        "image": image,
        "argv": ["/usr/bin/python3", "-c", uvtools_script.SCRIPT, canonical(spec).decode()],
        "input_mount": "/inputs",
        "output_mount": "/outputs",
        "network": "none",
        "limits": {
            "cpus": 2,
            "memory_bytes": 2 * 1024**3,
            "timeout_seconds": 600,
            "pids": 128,
            "max_output_bytes": RESIN_MAX_OUTPUT_BYTES,
        },
        "outputs": [
            {"path": p, "media_type": m, "rights": rights} for p, m in RESIN_OUTPUTS.items()
        ],
    }
