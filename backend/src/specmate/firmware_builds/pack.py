"""Exact compiler profile; image approval/cache installation is a separate operation."""

import hashlib
import json
import re

from specmate.firmware_builds.native_script import SCRIPT
from specmate.operations import Unsupported

TOOL_PACKAGES = {
    "gcc-avr": "1:5.4.0+Atmel3.6.2-3",
    "binutils-avr": "2.26.20160125+Atmel3.6.2-4",
    "avr-libc": "1:2.0.0+Atmel3.6.2-3",
}
ADAPTER = "firmware-avr-gcc-v1"
MAX_OUTPUT_BYTES = 16 * 1024**2
OUTPUT_MEDIA = {
    "compile.json": "application/json",
    "handoff.json": "application/json",
    "compile.log": "text/plain",
    "firmware.elf": "application/x-elf",
    "firmware.hex": "application/x-ihex",
}
TOOLCHAIN = {
    "family": "other",
    "name": "avr-gcc",
    "version": "5.4.0",
    "framework": "baremetal",
    "board_id": "atmega328p",
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def supported(firmware):
    if firmware["toolchain"] != TOOLCHAIN:
        raise Unsupported(
            "No installed compiler profile supports this exact declared toolchain. "
            "The bounded profile is avr-gcc 5.4.0 / baremetal / atmega328p; "
            "PlatformIO, ESP-IDF, Arduino CLI, Zephyr and other targets remain unverified."
        )
    if len(firmware["sources"]) != 1:
        raise Unsupported(
            "This compiler stage supports one exact source bundle; multiple bundles "
            "require a separately qualified pack."
        )
    files = firmware["sources"][0]["files"]
    if not any(f["role"] == "application" for f in files):
        raise Unsupported("An application C translation unit is required.")
    if any(f["role"] in ("application", "library") and not f["path"].endswith(".c") for f in files):
        raise Unsupported("The bounded compiler profile supports C translation units only.")
    if any(f["role"] in ("configuration", "lockfile") for f in files):
        raise Unsupported(
            "External build scripts/configuration cannot be silently ignored by this profile."
        )
    if len({f["rights"] for f in files}) != 1:
        raise Unsupported("Mixed output rights require a reviewed rights-composition profile.")
    for entry in firmware["configuration"]:
        if (
            entry["status"] != "known"
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", entry["key"])
            or not re.fullmatch(r"[0-9]{1,10}", entry["value"] or "")
        ):
            raise Unsupported(
                "This profile requires known unsigned integer C configuration macros; "
                "unknowns and secret references are not resolved or fabricated."
            )


def recipe_id(spec):
    return ADAPTER + "-" + hashlib.sha256(canonical(spec)).hexdigest()[:32]


def recipe_for(spec, image):
    supported(spec)
    encoded = canonical(spec).decode()
    if len(encoded) > 8192:
        raise Unsupported(
            "This exact compiler input manifest exceeds its bounded argument envelope."
        )
    rights = spec["sources"][0]["files"][0]["rights"]
    return {
        "id": recipe_id(spec),
        "image": image,
        "argv": ["/usr/bin/python3", "-c", SCRIPT, encoded],
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
