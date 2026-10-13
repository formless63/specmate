"""Run only inside the pinned KiCad pack; this is a narrow synthetic-fixture probe."""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(board, pcbnew):
    def point(value):
        return [round(pcbnew.ToMM(value.x), 6), round(pcbnew.ToMM(value.y), 6)]

    polygons = pcbnew.SHAPE_POLY_SET()
    if not board.GetBoardPolygonOutlines(polygons, False):
        raise ValueError("KiCad could not resolve a closed board outline")
    if polygons.OutlineCount() != 1 or polygons.HoleCount(0):
        raise ValueError("Fixture probe requires one outline without internal cutouts")
    outline = polygons.Outline(0)
    facts = {
        "units": "mm",
        "outline": [point(outline.CPoint(i)) for i in range(outline.PointCount())],
        "mounting_holes": [],
        "terminals": [],
        "copper_nets": {},
        "component_passages": [],
        "components": [],
    }
    for footprint in board.GetFootprints():
        reference = footprint.GetReference()
        value = footprint.GetValue()
        terminals = []
        facts["components"].append({"reference": reference, "value": value})
        for pad in footprint.Pads():
            if pad.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                drill = pad.GetDrillSize()
                if drill.x <= 0 or drill.y <= 0:
                    raise ValueError("Nonplated mounting pad has no drill")
                facts["mounting_holes"].append(point(pad.GetPosition()))
                continue
            terminal = f"{reference}.{pad.GetNumber()}"
            facts["terminals"].append(terminal)
            terminals.append(terminal)
            net = pad.GetNetname()
            if net:
                facts["copper_nets"].setdefault(net, []).append(terminal)
        # Deliberately limited fixture convention, not a general component classifier.
        # Copper membership comes exclusively from pad nets, never this passage.
        if re.fullmatch(r"R[1-9][0-9]*", reference):
            match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([RkM]?)", value)
            if not match or len(terminals) != 2:
                raise ValueError("Unsupported resistor value or terminal count")
            multiplier = {"": 1, "R": 1, "k": 1000, "M": 1000000}[match[2]]
            first, second = sorted(terminals)
            facts["component_passages"].append(
                {
                    "kind": "resistor",
                    "from": first,
                    "to": second,
                    "resistance_ohm": float(match[1]) * multiplier,
                }
            )
    return facts


def main():
    source, output = map(Path, sys.argv[1:])
    os.environ.update(
        HOME="/tmp/kicad-home",
        XDG_CONFIG_HOME="/tmp/kicad-home/config",
        XDG_CACHE_HOME="/tmp/kicad-home/cache",
    )
    Path(os.environ["HOME"]).mkdir(exist_ok=True)
    original = digest(source)
    execution = {"source_sha256": original, "commands": [], "status": "failed"}

    def command(argv):
        completed = subprocess.run(
            argv, check=False, capture_output=True, text=True, timeout=90
        )
        execution["commands"].append(
            {
                "argv": argv,
                "exit_code": completed.returncode,
                "stdout": completed.stdout[-16384:],
                "stderr": completed.stderr[-16384:],
            }
        )
        if completed.returncode:
            raise ValueError(f"Native command exited with {completed.returncode}")
        return completed.stdout.strip()

    try:
        execution["tool_version"] = command(["/usr/bin/kicad-cli", "version"])
        # Import and parse within this container only, including malformed input.
        import pcbnew

        execution["pcbnew_version"] = pcbnew.GetBuildVersion()
        execution["phase"] = "load_board"
        board = pcbnew.LoadBoard(str(source))
        if board is None:
            raise ValueError("KiCad returned no board")
        execution["phase"] = "extract"
        facts = extract(board, pcbnew)
        (output / "facts.json").write_text(json.dumps(facts, indent=2) + "\n")
        execution["phase"] = "drc"
        command(
            [
                "/usr/bin/kicad-cli",
                "pcb",
                "drc",
                "--format",
                "json",
                "--severity-error",
                "--exit-code-violations",
                "--output",
                str(output / "drc.json"),
                str(source),
            ]
        )
        execution["phase"] = "export"
        command(
            [
                "/usr/bin/kicad-cli",
                "pcb",
                "export",
                "svg",
                "--layers",
                "F.Cu,B.Cu,Edge.Cuts",
                "--mode-single",
                "--output",
                str(output / "board.svg"),
                str(source),
            ]
        )
        execution["status"] = "succeeded"
    except Exception as exc:  # noqa: BLE001
        # Native parser bindings raise several exception types; preserve the failure.
        execution["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        execution["source_unchanged"] = digest(source) == original
        if not execution["source_unchanged"]:
            execution["status"] = "failed"
        (output / "execution.json").write_text(json.dumps(execution, indent=2) + "\n")
    return 0 if execution["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
