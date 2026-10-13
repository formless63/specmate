#!/usr/bin/env python3
"""Validate fixture integrity, or explicitly run real isolated KiCad qualification."""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import signal
import sys
import time
import unittest
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runner"))

from specmate_runner.docker import Docker, RuntimeFailure, ToolUnavailable
from specmate_runner.validation import (
    Invalid,
    hash_file,
    inspect_outputs,
    safe_path,
    validate_manifest,
)

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "toolpacks/kicad/manifest.json"
EXPECTATIONS = "tests/fixtures/board-expectations.json"
PROBE = "tests/native/inspect_board.py"
GENERATOR = "toolpacks/kicad/generate_fixture.py"
GENERATION_PROBE = "tests/native/generate_board.py"
OUTPUTS = [
    {"path": "facts.json", "media_type": "application/json", "rights": "AGPL-3.0-only"},
    {"path": "drc.json", "media_type": "application/json", "rights": "AGPL-3.0-only"},
    {"path": "board.svg", "media_type": "image/svg+xml", "rights": "AGPL-3.0-only"},
    {
        "path": "execution.json",
        "media_type": "application/json",
        "rights": "AGPL-3.0-only",
    },
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    return json.loads(path.read_text())


def source_path(value):
    safe_path(value)
    path = ROOT / value
    require(path.resolve().is_relative_to(ROOT), "Source escapes public checkout")
    require(
        path.is_file() and not path.is_symlink(), "Missing or linked fixture source"
    )
    return path


def validate_pack():
    manifest = load(ROOT / MANIFEST)
    require(manifest["format_version"] == 1, "Unsupported native pack manifest")
    require(
        re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}", manifest["image"]),
        "Native image must be a digest-pinned reference",
    )
    require(
        not manifest["image"].endswith("0" * 64), "Placeholder image is not executable"
    )
    require(
        manifest["permissions"] == {"network": False, "read_only_inputs": True},
        "Fixture pack must deny network and preserve inputs",
    )
    require(
        manifest["platforms"] == ["linux/amd64"], "Unqualified platform declaration"
    )
    for name in ("fixture", "malformed_fixture"):
        path = source_path(manifest[name])
        require(hash_file(path) == manifest[f"{name}_sha256"], f"Hash mismatch: {name}")
    for path in (PROBE, GENERATOR, GENERATION_PROBE):
        source_path(path)
    validate_manifest(
        {
            "stage_id": "fixture",
            "build_id": "fixture",
            "source_revision_id": "fixture",
            "fencing_token": "static-validation",
            "inputs": [],
            "recipe": recipe_for(manifest, manifest["limits"]["timeout_seconds"]),
        }
    )
    expectation = load(ROOT / EXPECTATIONS)
    require(
        expectation["synthetic"] is True and expectation["units"] == "mm",
        "Independent oracle must be synthetic and dimensioned",
    )
    return manifest, expectation


def polygon(points):
    """Accept different starting vertices/winding; preserve every geometric vertex."""
    points = [tuple(point) for point in points]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    require(len(points) >= 3, "Missing board outline")
    variants = []
    for direction in (points, list(reversed(points))):
        variants.extend(
            tuple(direction[i:] + direction[:i]) for i in range(len(points))
        )
    return min(variants)


def compare_facts(actual, expected):
    require(actual["units"] == expected["units"], "Board units differ")
    require(
        polygon(actual["outline"]) == polygon(expected["outline"]),
        "Board outline differs",
    )
    require(
        sorted(map(tuple, actual["mounting_holes"]))
        == sorted(map(tuple, expected["mounting_holes"])),
        "Mounting hole locations differ",
    )
    require(
        sorted(actual["terminals"]) == sorted(expected["terminals"]), "Terminals differ"
    )
    actual_nets = {key: sorted(value) for key, value in actual["copper_nets"].items()}
    expected_nets = {
        key: sorted(value) for key, value in expected["copper_nets"].items()
    }
    require(
        actual_nets == expected_nets,
        "Copper nets differ (component passages must stay separate)",
    )
    require(
        sorted(actual["component_passages"], key=lambda value: value["from"])
        == sorted(expected["component_passages"], key=lambda value: value["from"]),
        "Resistor semantics differ",
    )
    require(
        len(actual_nets) == expected["expected"]["copper_net_count"],
        "Copper net count differs",
    )
    require(
        len(actual["mounting_holes"]) == expected["expected"]["mounting_hole_count"],
        "Mounting hole count differs",
    )


def recipe_for(manifest, timeout):
    limits = manifest["limits"]
    return {
        "id": manifest["id"],
        "image": manifest["image"],
        "network": "none",
        "input_mount": "/inputs",
        "output_mount": "/outputs",
        "argv": [
            "/usr/bin/python3",
            "/inputs/inspect_board.py",
            "/inputs/board.kicad_pcb",
            "/outputs",
        ],
        "limits": {
            "cpus": limits["cpus"],
            "memory_bytes": limits["memory_mb"] * 1024**2,
            "pids": limits["pids"],
            "timeout_seconds": timeout,
            "max_output_bytes": 16 * 1024**2,
        },
        "outputs": OUTPUTS,
    }


def validate_svg(path):
    svg = ET.parse(path).getroot()
    require(svg.tag == "{http://www.w3.org/2000/svg}svg", "Invalid SVG export")

    def drawable(element):
        kind = element.tag.removeprefix("{http://www.w3.org/2000/svg}")
        if kind in {
            "defs",
            "metadata",
            "title",
            "desc",
            "clipPath",
            "symbol",
            "pattern",
            "marker",
        }:
            return False
        if kind == "path" and re.search(r"[LlHhVvCcSsQqTtAaZz]", element.get("d", "")):
            return True
        if kind in {"polyline", "polygon"} and element.get("points", "").strip():
            return True
        if kind == "line" and any(element.get(key) for key in ("x1", "x2", "y1", "y2")):
            return True
        return any(drawable(child) for child in element)

    require(drawable(svg), "SVG export contains no drawable geometry")


def run_case(runtime, manifest, fixture, directory, timeout, *, generation=False):
    directory.mkdir()
    inputs, outputs = directory / "inputs", directory / "outputs"
    inputs.mkdir(mode=0o755)
    outputs.mkdir(mode=0o700)
    if os.getuid() == 0:
        os.chown(outputs, *map(int, runtime.user.split(":")))
    staged_files = [
        (source_path(fixture), "board.kicad_pcb"),
        (ROOT / PROBE, "inspect_board.py"),
    ]
    if generation:
        staged_files = [
            (ROOT / GENERATOR, "generate_fixture.py"),
            (ROOT / GENERATION_PROBE, "generate_board.py"),
        ]
    for source, target in staged_files:
        shutil.copyfile(source, inputs / target)
        (inputs / target).chmod(0o444)
    recipe = recipe_for(manifest, timeout)
    if generation:
        recipe["argv"] = [
            "/usr/bin/python3",
            "/inputs/generate_board.py",
            "/inputs/generate_fixture.py",
            "/outputs",
        ]
        recipe["outputs"] = [
            {
                "path": "generated.kicad_pcb",
                "rights": "AGPL-3.0-only",
                "media_type": "application/x-kicad-pcb",
            },
            {
                "path": "generation.json",
                "rights": "AGPL-3.0-only",
                "media_type": "application/json",
            },
        ]
    identity = uuid.uuid4().hex
    lease = {
        "stage_id": identity,
        "build_id": identity,
        "source_revision_id": identity,
        "fencing_token": "fixture-probe",
        "recipe": recipe,
        "inputs": [
            {
                "path": path.name,
                "sha256": hash_file(path),
                "bytes": path.stat().st_size,
                "rights": "AGPL-3.0-only",
                "media_type": "application/octet-stream",
            }
            for path in inputs.iterdir()
        ],
    }
    validate_manifest(lease)
    name = f"specmate-fixture-{identity}"
    result = {
        "status": "failed",
        "fixture": fixture,
        "recipe": recipe,
        "input_hashes": {item["path"]: item["sha256"] for item in lease["inputs"]},
    }
    started = time.monotonic()
    try:
        runtime.create(name, identity, recipe, inputs, outputs)
        runtime.start(name)
        while True:
            container = runtime.inspect(name, identity)
            require(container is not None, "Fixture container disappeared")
            inspect_outputs(
                outputs,
                recipe["outputs"],
                recipe["limits"]["max_output_bytes"],
                complete=False,
            )
            if not container["State"]["Running"]:
                result["exit_code"] = container["State"]["ExitCode"]
                result["status"] = "succeeded" if result["exit_code"] == 0 else "failed"
                break
            if time.monotonic() - started >= timeout:
                result["status"] = "timed_out"
                break
            time.sleep(0.2)
    finally:
        stopped = runtime.stop(name, identity)
        result["termination_confirmed"] = (
            stopped is None or not stopped["State"]["Running"]
        )
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        if stopped:
            runtime.remove(name, identity)
        result["source_unchanged"] = all(
            hash_file(inputs / item["path"]) == item["sha256"]
            for item in lease["inputs"]
        )
        (directory / "stage.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def qualify(manifest, expected, destination, timeout):
    user = (
        f"{os.getuid()}:{os.getgid()}" if os.getuid() and os.getgid() else "65532:65532"
    )
    runtime = Docker(user=user)
    image = json.loads(runtime.command(["image", "inspect", manifest["image"]]))[0]
    require(
        f"{image['Os']}/{image['Architecture']}" in manifest["platforms"],
        "Unsupported image platform",
    )
    results = {}
    generation_hashes = []
    for index in (1, 2):
        label = f"generation-{index}"
        generation = run_case(
            runtime,
            manifest,
            manifest["fixture"],
            destination / label,
            timeout,
            generation=True,
        )
        results[label] = generation
        require(generation["status"] == "succeeded", "Native fixture generation failed")
        generated = inspect_outputs(
            destination / label / "outputs",
            generation["recipe"]["outputs"],
            16 * 1024**2,
            complete=True,
        )
        artifact = next(
            item for item in generated if item["path"] == "generated.kicad_pcb"
        )
        require(
            artifact["sha256"] == manifest["fixture_sha256"],
            "Native generation differs from frozen fixture",
        )
        generation_hashes.append(artifact["sha256"])
    valid = run_case(
        runtime, manifest, manifest["fixture"], destination / "valid", timeout
    )
    results["valid"] = valid
    require(
        valid["status"] == "succeeded",
        "Native fixture stage failed; inspect valid/outputs/execution.json",
    )
    require(valid["source_unchanged"], "Native source changed")
    outputs = destination / "valid" / "outputs"
    artifacts = inspect_outputs(outputs, OUTPUTS, 16 * 1024**2, complete=True)
    execution = load(outputs / "execution.json")
    require(
        execution["status"] == "succeeded" and execution["source_unchanged"],
        "Native probe did not complete",
    )
    require(
        execution["tool_version"] == manifest["tool_version"],
        "Native tool version differs from pack",
    )
    require(
        execution["pcbnew_version"] == manifest["tool_version"],
        "Native parser version differs from pack",
    )
    compare_facts(load(outputs / "facts.json"), expected)
    report = load(outputs / "drc.json")
    require(
        not report["violations"] and not report["unconnected_items"],
        "KiCad DRC errors or unconnected items",
    )
    require(
        not report.get("schematic_parity", []), "KiCad reports schematic parity errors"
    )
    validate_svg(outputs / "board.svg")
    invalid = run_case(
        runtime,
        manifest,
        manifest["malformed_fixture"],
        destination / "invalid",
        timeout,
    )
    results["invalid"] = invalid
    require(
        invalid["status"] == "failed" and invalid.get("exit_code", 0) != 0,
        "Malformed input did not fail native parsing",
    )
    failure = load(destination / "invalid" / "outputs" / "execution.json")
    require(
        failure["status"] == "failed" and failure.get("error"),
        "Malformed input has no failure evidence",
    )
    require(
        failure.get("phase") == "load_board",
        "Malformed input did not fail within the native parser",
    )
    require(
        failure["source_unchanged"] and invalid["termination_confirmed"],
        "Malformed source/termination failed",
    )
    checkpoint = runner_checkpoint(manifest["image"], destination)
    return {
        "image_id": image["Id"],
        "cases": results,
        "artifacts": artifacts,
        "generation_sha256": generation_hashes,
        "runner_checkpoint": checkpoint,
        "drc_ignored_checks": report.get("ignored_checks", []),
        "checks": [
            "deterministic-native-generation",
            "outline",
            "mounting-holes",
            "terminals",
            "separate-copper-nets",
            "resistor-passage",
            "drc-errors",
            "svg-export",
            "malformed-native-input",
        ],
        "not_verified": [
            "procurement-policy",
            "physical-qualification",
            "other-native-tools",
            "arm64",
            "full-application-import",
            "release-distribution",
        ],
    }


def runner_checkpoint(image, destination):
    """Actual processes/receipts; control faults are simulated, not live HTTP."""
    previous_image = os.environ.get("SPECMATE_RUNNER_TEST_IMAGE")
    os.environ["SPECMATE_RUNNER_TEST_IMAGE"] = image
    stream, captured = io.StringIO(), io.StringIO()
    active_result, interrupted = None, []

    class CheckpointResult(unittest.TextTestResult):
        def __init__(self, *args, **kwargs):
            nonlocal active_result
            super().__init__(*args, **kwargs)
            active_result = self

    def interrupt(signum, frame):
        interrupted.append(signum)
        if active_result is not None:
            active_result.stop()
        # Exception, not forced child death: unittest still runs receipt-scoped cleanup.
        raise TimeoutError("Runner checkpoint interrupted or exceeded its deadline")

    signals = (signal.SIGALRM, signal.SIGINT, signal.SIGTERM)
    handlers = {number: signal.getsignal(number) for number in signals}
    try:
        for number in signals:
            signal.signal(number, interrupt)
        signal.alarm(300)
        spec = importlib.util.spec_from_file_location(
            "native_runner_checkpoint", ROOT / "runner/tests/test_runner.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(
            module.DockerIntegrationTests
        )
        require(suite.countTestCases() >= 6, "Runner recovery scenarios are missing")
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            result = unittest.TextTestRunner(
                stream=stream, verbosity=2, resultclass=CheckpointResult
            ).run(suite)
        require(
            result.wasSuccessful() and not result.skipped and not interrupted,
            "Real runner checkpoint failed, was interrupted, or was skipped",
        )
    finally:
        signal.alarm(0)
        for number, handler in handlers.items():
            signal.signal(number, handler)
        if previous_image is None:
            os.environ.pop("SPECMATE_RUNNER_TEST_IMAGE", None)
        else:
            os.environ["SPECMATE_RUNNER_TEST_IMAGE"] = previous_image
        (destination / "runner-checkpoint.stdout").write_text(captured.getvalue())
        (destination / "runner-checkpoint.stderr").write_text(stream.getvalue())
    return {
        "exit_code": 0,
        "tests": result.testsRun,
        "evidence_level": "real-container-process-and-recovery",
        "control_plane": "simulated-heartbeat-fencing-and-lost-acknowledgment",
        "test_source_sha256": hash_file(ROOT / "runner/tests/test_runner.py"),
        "stderr": "runner-checkpoint.stderr",
        "stdout": "runner-checkpoint.stdout",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--real-tools",
        action="store_true",
        help="Explicitly execute the cached pinned native image",
    )
    parser.add_argument(
        "--output", type=Path, help="New evidence directory outside the source checkout"
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        help="Bound each native stage (at most pack limit)",
    )
    args = parser.parse_args(argv)
    previous_terminate = signal.getsignal(signal.SIGTERM)

    def cancel(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, cancel)
    evidence, destination = (
        {"format_version": 1, "evidence_level": "real-tool", "status": "failed"},
        None,
    )
    try:
        manifest, expected = validate_pack()
        if not args.real_tools:
            require(
                args.output is None and args.timeout_seconds is None,
                "Output/timeout require --real-tools",
            )
            print("Native fixture manifest and hashes passed. Real tools were not run.")
            return 0
        require(
            args.output is not None,
            "--real-tools requires --output outside the checkout",
        )
        candidate = args.output.resolve()
        require(
            not candidate.is_relative_to(ROOT),
            "Native evidence must stay outside the source checkout",
        )
        require(
            "," not in str(candidate),
            "Output path cannot contain a Docker mount separator",
        )
        require(
            not candidate.exists(),
            "Evidence directory already exists; choose a new path",
        )
        timeout = (
            args.timeout_seconds
            if args.timeout_seconds is not None
            else manifest["limits"]["timeout_seconds"]
        )
        require(
            1 <= timeout <= manifest["limits"]["timeout_seconds"],
            "Timeout exceeds pack bound",
        )
        candidate.mkdir(parents=True, mode=0o700)
        destination = candidate
        evidence.update(
            image=manifest["image"],
            fixture_sha256=manifest["fixture_sha256"],
            manifest_sha256=hash_file(ROOT / MANIFEST),
            oracle_sha256=hash_file(ROOT / EXPECTATIONS),
            probe_sha256=hash_file(ROOT / PROBE),
            generator_sha256=hash_file(ROOT / GENERATOR),
            generation_probe_sha256=hash_file(ROOT / GENERATION_PROBE),
            checker_sha256=hash_file(Path(__file__)),
            runner_sha256={
                path.name: hash_file(path)
                for path in sorted((ROOT / "runner/specmate_runner").glob("*.py"))
            },
        )
        evidence.update(qualify(manifest, expected, destination, timeout))
        evidence["status"] = "passed"
        print(f"Real KiCad fixture checks passed: {destination / 'evidence.json'}")
        print(
            "Synthetic fixture evidence is not physical qualification "
            "or complete PCB intake acceptance."
        )
        return 0
    except (ToolUnavailable, RuntimeFailure) as exc:
        evidence.update(status="unavailable", error=str(exc))
        print(f"Native fixture unavailable: {exc}", file=sys.stderr)
        return 2
    except (ValueError, KeyError, TypeError, OSError, Invalid, ET.ParseError) as exc:
        evidence["error"] = str(exc)
        print(f"Native fixture check failed: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        evidence.update(
            status="cancelled", error="Controller interrupted; stage cleanup attempted"
        )
        return 130
    finally:
        signal.signal(signal.SIGTERM, previous_terminate)
        if destination is not None and destination.exists():
            (destination / "evidence.json").write_text(
                json.dumps(evidence, indent=2) + "\n"
            )


if __name__ == "__main__":
    raise SystemExit(main())
