#!/usr/bin/env python3
"""Explicit standalone cached-image fabrication probe, not approved-runner acceptance."""

import argparse
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/src"))

from check_native_fixtures import validate_pack
from fabrication_outputs import check_outputs, excellon
from specmate.pcb_fabrication.pack import REPORT_PATH, recipe_for
from specmate.pcb_fabrication.report import FailureReport, Report
from specmate_runner.docker import Docker
from specmate_runner.validation import hash_file, inspect_outputs

# Original synthetic project settings: one text variable and a stricter track rule
# than the fixture's 0.5 mm tracks, so applying the project is observable.
PROJECT = {
    "meta": {"filename": "board.kicad_pro", "version": 3},
    "text_variables": {"SYNTH_REV": "B"},
    "board": {"design_settings": {"rules": {"min_track_width": 0.6}}},
}

# Original synthetic additions: an arc top edge, a circular cutout, a through via,
# a stored copper zone fill, production-layer graphics/text and an oval NPTH slot.
ARC_EDGE = """\t(gr_arc
\t\t(start 0 0)
\t\t(mid 20 -3)
\t\t(end 40 0)
\t\t(stroke
\t\t\t(width 0.05)
\t\t\t(type default)
\t\t)
\t\t(layer "Edge.Cuts")
\t\t(uuid "3c6b0a7e-0d4f-4b8e-9a51-6f1d2e9c7a10")
\t)
"""
ADDITIONS = """\t(gr_circle
\t\t(center 32 18)
\t\t(end 33.5 18)
\t\t(stroke
\t\t\t(width 0.05)
\t\t\t(type default)
\t\t)
\t\t(fill no)
\t\t(layer "Edge.Cuts")
\t\t(uuid "3c6b0a7e-0d4f-4b8e-9a51-6f1d2e9c7a11")
\t)
\t(gr_text "SYNTH ${SYNTH_REV}"
\t\t(at 20 21 0)
\t\t(layer "F.SilkS")
\t\t(uuid "3c6b0a7e-0d4f-4b8e-9a51-6f1d2e9c7a12")
\t\t(effects
\t\t\t(font
\t\t\t\t(size 1 1)
\t\t\t\t(thickness 0.15)
\t\t\t)
\t\t)
\t)
\t(gr_line
\t\t(start 14 5)
\t\t(end 20 5)
\t\t(stroke
\t\t\t(width 0.3)
\t\t\t(type default)
\t\t)
\t\t(layer "F.Cu")
\t\t(uuid "3c6b0a7e-0d4f-4b8e-9a51-6f1d2e9c7a13")
\t)
\t(via
\t\t(at 30 10)
\t\t(size 0.8)
\t\t(drill 0.4)
\t\t(layers "F.Cu" "B.Cu")
\t\t(net "N1")
\t\t(uuid "3c6b0a7e-0d4f-4b8e-9a51-6f1d2e9c7a14")
\t)
\t(zone
\t\t(net "N2")
\t\t(layer "B.Cu")
\t\t(uuid "3c6b0a7e-0d4f-4b8e-9a51-6f1d2e9c7a15")
\t\t(hatch edge 0.5)
\t\t(connect_pads
\t\t\t(clearance 0.5)
\t\t)
\t\t(min_thickness 0.25)
\t\t(fill yes
\t\t\t(thermal_gap 0.5)
\t\t\t(thermal_bridge_width 0.5)
\t\t)
\t\t(polygon
\t\t\t(pts
\t\t\t\t(xy 8 16) (xy 16 16) (xy 16 20) (xy 8 20)
\t\t\t)
\t\t)
\t\t(filled_polygon
\t\t\t(layer "B.Cu")
\t\t\t(pts
\t\t\t\t(xy 8.5 16.5) (xy 15.5 16.5) (xy 15.5 19.5) (xy 8.5 19.5)
\t\t\t)
\t\t)
\t)
"""


def run_case(runtime, directory, files, board, recipe):
    """Stage exact inputs read-only and run one recipe through the runner's Docker boundary."""
    directory.mkdir()
    inputs, outputs = directory / "inputs", directory / "outputs"
    inputs.mkdir(mode=0o755)
    outputs.mkdir(mode=0o700)
    if os.getuid() == 0:
        os.chown(outputs, *map(int, runtime.user.split(":")))
    for name, text in files.items():
        (inputs / name).write_text(text)
        (inputs / name).chmod(0o444)
    before = {name: hash_file(inputs / name) for name in files}
    identity = uuid.uuid4().hex
    name = f"specmate-pcb-fabrication-{identity}"
    result = {"status": "failed", "exit_code": None}
    started = time.monotonic()
    try:
        runtime.create(name, identity, recipe, inputs, outputs)
        runtime.start(name)
        while True:
            container = runtime.inspect(name, identity)
            if container is None:
                raise ValueError("Fabrication container disappeared")
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
        result["source_unchanged"] = before == {n: hash_file(inputs / n) for n in files}
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        (directory / "stage.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def drill_hits(path):
    hits, _ = excellon(path)
    return {(x, y) for x, y, _ in hits}


def positive(outputs, report, pth=False):
    # Independent fixture geometry, separate from native report claims.
    if drill_hits(outputs / "board-NPTH.drl") != {
        (3, -3),
        (3, -22),
        (37, -3),
        (37, -22),
    }:
        raise ValueError("Independent nonplated drill coordinates differ")
    if "T1C2.000" not in (outputs / "board-NPTH.drl").read_text():
        raise ValueError("Independent nonplated diameter differs")
    if drill_hits(outputs / "board-PTH.drl") != ({(25, -10)} if pth else set()):
        raise ValueError("Independent plated drill coordinates differ")
    if pth and "T1C0.800" not in (outputs / "board-PTH.drl").read_text():
        raise ValueError("Independent plated diameter differs")
    edge = (outputs / "board-Edge_Cuts.gbr").read_text()
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
    if report.manufacturing_approval or report.physical_qualification:
        raise ValueError("Native export cannot establish approval")


def features(outputs, report, project):
    """Independent checks of the original synthetic real-feature additions."""
    edge = (outputs / "board-Edge_Cuts.gbr").read_text()
    if not re.search(r"^X(?:40000000|0)Y0I-?\d+J-?\d+D01\*$", edge, re.MULTILINE):
        raise ValueError("Arc top edge is missing from the outline Gerber")
    if "G75*" not in edge and "G02*" not in edge and "G03*" not in edge:
        raise ValueError("Outline Gerber has no circular interpolation")
    hits, _ = excellon(outputs / "board-PTH.drl")
    if set(hits) != {(30.0, -10.0, 0.4)}:
        raise ValueError("Independent through-via drill differs")
    _, slots = excellon(outputs / "board-NPTH.drl")
    if [(min(s[0], s[2]), s[1], max(s[0], s[2]), s[3], s[4]) for s in slots] != [
        (36.5, -22.0, 37.5, -22.0, 1.0)
    ]:
        raise ValueError("Independent oval slot differs")
    back = (outputs / "board-B_Cu.gbr").read_text()
    if "G36*" not in back or "X8500000Y-16500000" not in back:
        raise ValueError("Stored zone fill is missing from back copper")
    if "X14000000Y-5000000" not in (outputs / "board-F_Cu.gbr").read_text():
        raise ValueError("Production copper graphic is missing")
    expected = 0 if project else 1
    if report.features.unresolved_text_variables != expected:
        raise ValueError("Project text variable resolution differs")
    if report.features.cutouts != 1 or report.features.through_vias != 1:
        raise ValueError("Reported cutout/via features differ")
    if (report.project is not None) != project:
        raise ValueError("Project companion was not recorded")


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
    top = re.search(
        r"\t\(gr_line\n\t\t\(start 0 0\)\n\t\t\(end 40 0\)\n.*?\n\t\)\n",
        original,
        re.DOTALL,
    )
    rich = original[: top.start()] + ARC_EDGE + original[top.end() :]
    rich = rich.replace(
        "\t(embedded_fonts no)\n)", ADDITIONS + "\t(embedded_fonts no)\n)"
    )
    rich = rich.replace("(drill 2)", "(drill oval 2 1)", 1)
    if disconnected == original or rich.count("3c6b0a7e") != 6:
        raise ValueError("Synthetic mutation did not apply")
    project = json.dumps(PROJECT, indent=2) + "\n"
    board = "board.kicad_pcb"
    cases = {
        "original": ({board: original}, 2, 0),
        "plated": ({board: pth}, 2, 0),
        "disconnected": ({board: disconnected}, 2, 0),
        "features": ({board: rich}, 2, 0),
        "features-with-project": ({board: rich, "board.kicad_pro": project}, 2, 0),
        "invalid-project": ({board: original, "board.kicad_pro": "{not json\n"}, 2, 20),
        "layer-count-mismatch": ({board: original}, 4, 14),
        "dnp-unsupported": (
            {board: original.replace("(attr smd)", "(attr smd dnp)", 1)},
            2,
            18,
        ),
        "malformed": (
            {board: (ROOT / manifest["malformed_fixture"]).read_text()},
            2,
            13,
        ),
    }
    results, reports = {}, {}
    for name, (files, copper, code) in cases.items():
        recipe = recipe_for(board, "AGPL-3.0-only", copper)
        result = run_case(runtime, directory / name, files, board, recipe)
        if result["exit_code"] != code or not result["source_unchanged"]:
            raise ValueError(
                f"Native case failed its expected outcome: {name} {result}"
            )
        outputs = directory / name / "outputs"
        raw = (outputs / REPORT_PATH).read_bytes()
        if code:
            failure = FailureReport.model_validate_json(raw)
            if failure.code != code:
                raise ValueError(
                    "Failure report code differs from the exit code: " + name
                )
        else:
            report = Report.model_validate_json(raw)
            reports[name] = report
            check_outputs(outputs, json.loads(raw))
            if name in {"original", "plated", "disconnected"}:
                positive(outputs, report, pth=name == "plated")
            if name.startswith("features"):
                features(outputs, report, project=name.endswith("project"))
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
    widths = {
        name: sum(
            v["type"] == "track_width"
            for v in json.loads((directory / name / "outputs/drc.json").read_bytes())[
                "violations"
            ]
        )
        for name in ("features", "features-with-project")
    }
    if not widths["features-with-project"] > widths["features"]:
        raise ValueError("Project design rules were not applied by native DRC")
    (directory / "result.json").write_text(
        json.dumps(
            {
                "status": "passed",
                "evidence_level": "standalone-real-tool",
                "image": recipe["image"],
                "cases": results,
                "project_track_width_findings": widths,
                "approved_runner_pipeline": "not-tested-by-this-probe",
                "manufacturing_approval": False,
                "physical_qualification": False,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        "Standalone KiCad fabrication: independent Gerber/drill geometry, project rules, "
        "real-board features and specific failure diagnostics passed"
    )


if __name__ == "__main__":
    main()
