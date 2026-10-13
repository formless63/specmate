#!/usr/bin/env python3
"""Explicit cached-image PCB extraction checkpoint; writes external evidence only."""

import argparse
import json
import os
import shutil
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/src"))

from check_native_fixtures import compare_facts, validate_pack  # noqa: E402
from specmate_runner.docker import Docker  # noqa: E402
from specmate_runner.validation import hash_file, inspect_outputs  # noqa: E402

from specmate.pcb.pack import recipe_for  # noqa: E402
from specmate.pcb.report import Report  # noqa: E402


def run_stage(runtime, directory, manifest, recipe, fixture="fixture"):
    directory.mkdir()
    inputs, outputs = directory / "inputs", directory / "outputs"
    inputs.mkdir(mode=0o755)
    outputs.mkdir(mode=0o700)
    if os.getuid() == 0:
        os.chown(outputs, *map(int, runtime.user.split(":")))
    source = inputs / "board.kicad_pcb"
    shutil.copyfile(ROOT / manifest[fixture], source)
    source.chmod(0o444)
    original = hash_file(source)
    identity = uuid.uuid4().hex
    name = f"specmate-pcb-intake-{identity}"
    result = {"status": "failed", "recipe": recipe, "source_sha256": original}
    started = time.monotonic()
    try:
        runtime.create(name, identity, recipe, inputs, outputs)
        runtime.start(name)
        while True:
            container = runtime.inspect(name, identity)
            if container is None:
                raise ValueError("PCB extraction container disappeared")
            if not container["State"]["Running"]:
                result["exit_code"] = container["State"]["ExitCode"]
                result["status"] = "succeeded" if result["exit_code"] == 0 else "failed"
                inspect_outputs(
                    outputs,
                    recipe["outputs"],
                    recipe["limits"]["max_output_bytes"],
                    complete=result["status"] == "succeeded",
                )
                break
            if time.monotonic() - started > recipe["limits"]["timeout_seconds"]:
                result["status"] = "timed_out"
                break
            time.sleep(0.2)
    finally:
        runtime.stop(name, identity)
        runtime.remove(name, identity)
        result["source_unchanged"] = hash_file(source) == original
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        (directory / "stage.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    directory = args.evidence_dir.resolve()
    if directory.is_relative_to(ROOT) or directory.exists():
        parser.error("Evidence must be a new directory outside the public checkout")
    manifest, expected = validate_pack()
    directory.mkdir(parents=True)
    runtime = Docker(user=f"{os.getuid() or 65532}:{os.getgid() or 65532}")
    image = json.loads(
        runtime.command(
            ["image", "inspect", recipe_for("board.kicad_pcb", "AGPL-3.0-only")["image"]]
        )
    )[0]
    if f"{image['Os']}/{image['Architecture']}" != "linux/amd64":
        raise ValueError("This PCB adapter is qualified only on linux/amd64")
    recipe = recipe_for("board.kicad_pcb", "AGPL-3.0-only")
    valid = run_stage(runtime, directory / "valid", manifest, recipe=recipe)
    if valid["status"] != "succeeded" or not valid["source_unchanged"]:
        raise ValueError("Native PCB extraction failed; inspect external evidence")
    report = Report.model_validate_json((directory / "valid/outputs/pcb-intake.json").read_bytes())
    facts = report.model_dump(mode="json", by_alias=True)
    compare_facts(
        {
            "units": facts["units"],
            "outline": facts["outline"][0],
            "mounting_holes": [h["position"] for h in facts["mounting_holes"]],
            "terminals": [p["terminal"] for p in facts["pads"] if p["type"] != "npth"],
            "copper_nets": facts["copper_nets"],
            "component_passages": facts["component_passages"],
        },
        expected,
    )
    placements = {c.reference: c.position for c in report.components}
    if placements != {
        "J1": (10, 10),
        "R1": (25, 10),
        "H1": (3, 3),
        "H2": (37, 3),
        "H3": (3, 22),
        "H4": (37, 22),
    }:
        raise ValueError("Independent fixture placement expectations differ")
    invalid = run_stage(
        runtime, directory / "invalid", manifest, fixture="malformed_fixture", recipe=recipe
    )
    if invalid["status"] != "failed" or not invalid["source_unchanged"]:
        raise ValueError("Malformed CAD must fail and preserve original bytes")
    (directory / "result.json").write_text(
        json.dumps(
            {
                "status": "passed",
                "evidence_level": "real-tool",
                "source_sha256": report.source_sha256,
                "image": recipe["image"],
                "physical_qualification": False,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        "PCB intake: native extraction, independent geometry/nets/passages/placements, "
        "malformed input passed"
    )


if __name__ == "__main__":
    main()
