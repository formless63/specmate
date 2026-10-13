#!/usr/bin/env python3
"""Explicit standalone cached-image fabrication probe, not approved-runner acceptance."""

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/src"))

from check_native_fixtures import validate_pack
from check_pcb_intake import run_stage
from specmate.pcb_fabrication.pack import LAYERS, REPORT_PATH, recipe_for
from specmate.pcb_fabrication.report import Report
from specmate_runner.docker import Docker


def drill_hits(path):
    return {
        (float(x), -float(y))
        for x, y in re.findall(
            r"^X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)$", path.read_text(), re.MULTILINE
        )
    }


def positive(outputs, report, pth=False):
    # Independent fixture geometry, separate from native report claims.
    if drill_hits(outputs / "board-NPTH.drl") != {(3, 3), (3, 22), (37, 3), (37, 22)}:
        raise ValueError("Independent nonplated drill coordinates differ")
    if "T1C2.000" not in (outputs / "board-NPTH.drl").read_text():
        raise ValueError("Independent nonplated diameter differs")
    if drill_hits(outputs / "board-PTH.drl") != ({(25, 10)} if pth else set()):
        raise ValueError("Independent plated drill coordinates differ")
    if pth and "T1C0.800" not in (outputs / "board-PTH.drl").read_text():
        raise ValueError("Independent plated diameter differs")
    edge = (outputs / "board-Edge_Cuts.gbr").read_text()
    if "%FSLAX46Y46*%" not in edge or "%MOMM*%" not in edge:
        raise ValueError("Gerber precision/units differ")
    for point in ("X0Y0", "X40000000Y0", "X40000000Y-25000000", "X0Y-25000000"):
        if point not in edge:
            raise ValueError("Independent outline coordinates differ")
    copper = (outputs / "board-F_Cu.gbr").read_text()
    for point in (
        "X10000000Y-10000000",
        "X25000000Y-10000000",
        "X10000000Y-15000000",
        "X25000000Y-15000000",
    ):
        if point not in copper:
            raise ValueError("Independent front copper coordinates differ")
    job = json.loads((outputs / "board-job.gbrjob").read_bytes())
    if job["GeneralSpecs"]["LayerNumber"] != 2:
        raise ValueError("Gerber job copper layer count differs")
    expected = {
        "board-" + layer.replace(".", "_").replace("SilkS", "Silkscreen") + ".gbr"
        for layer in LAYERS
    }
    if {f["Path"] for f in job["FilesAttributes"]} != expected:
        raise ValueError("Gerber job does not reference every exact declared layer")
    if report.manufacturing_approval or report.physical_qualification:
        raise ValueError("Native export cannot establish approval")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    directory = args.evidence_dir.resolve()
    if directory.exists() or directory.is_relative_to(ROOT):
        parser.error("Evidence must be a new directory outside the public checkout")
    directory.mkdir(parents=True)
    manifest, _ = validate_pack()
    runtime = Docker(user=f"{os.getuid() or 65532}:{os.getgid() or 65532}")
    recipe = recipe_for("board.kicad_pcb", "AGPL-3.0-only")
    image = json.loads(runtime.command(["image", "inspect", recipe["image"]]))[0]
    if f"{image['Os']}/{image['Architecture']}" != "linux/amd64":
        raise ValueError("Only the exact amd64 image is qualified")
    original = (ROOT / manifest["fixture"]).read_text()
    # Original source modifications occur only in private synthetic test copies.
    pth = original.replace('(pad "1" smd rect', '(pad "1" thru_hole circle', 1)
    pth = pth.replace(
        '(layers "F.Cu" "F.Mask" "F.Paste")',
        '(drill 0.8)\n\t\t\t(layers "*.Cu" "*.Mask")',
        1,
    )
    disconnected = re.sub(
        r"\n\t\(segment\n.*?\n\t\)", "", original, count=1, flags=re.DOTALL
    )
    if disconnected == original:
        raise ValueError("Synthetic disconnected mutation did not remove a track")
    cases = {
        "original": original,
        "plated": pth,
        "disconnected": disconnected,
        "slot-unsupported": original.replace("(drill 2)", "(drill oval 2 1)", 1),
        "dnp-unsupported": original.replace("(attr smd)", "(attr smd dnp)", 1),
        "malformed": (ROOT / manifest["malformed_fixture"]).read_text(),
    }
    results = {}
    for name, text in cases.items():
        source = directory / f"{name}.kicad_pcb"
        source.write_text(text)
        result = run_stage(runtime, directory / name, {"fixture": str(source)}, recipe)
        success = name in {"original", "plated", "disconnected"}
        if (
            result["status"] != ("succeeded" if success else "failed")
            or not result["source_unchanged"]
        ):
            raise ValueError("Native case failed its expected outcome: " + name)
        if success:
            outputs = directory / name / "outputs"
            report = Report.model_validate_json((outputs / REPORT_PATH).read_bytes())
            positive(outputs, report, pth=name == "plated")
            if name == "disconnected" and report.drc_counts.unconnected_items == 0:
                raise ValueError(
                    "Disconnected board must report native unconnected findings"
                )
            if name == "original" and report.drc_counts.violations != 0:
                raise ValueError(
                    "Original independent fixture DRC should have no violations"
                )
        results[name] = {
            k: result[k] for k in ("status", "exit_code", "source_unchanged")
        }
    (directory / "result.json").write_text(
        json.dumps(
            {
                "status": "passed",
                "evidence_level": "standalone-real-tool",
                "image": recipe["image"],
                "cases": results,
                "approved_runner_pipeline": "not-tested-by-this-probe",
                "manufacturing_approval": False,
                "physical_qualification": False,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        "Standalone KiCad fabrication: independent Gerber/drill geometry, DRC findings and native rejection cases passed"
    )


if __name__ == "__main__":
    main()
