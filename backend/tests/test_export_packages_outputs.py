"""DOC-001 server-generated formboard prints and retained firmware build outputs.

Expected values are derived here from the synthetic fixtures (cut lengths, paper size,
registered file bytes), not from the generator. Registered compiler outputs are contract
fixtures: no compiler, device or flashing is involved, and a package is not approval.
"""
# ruff: noqa: F811

import copy
import json

import pytest

from specmate.export_packages import operations  # noqa: F401
from specmate.export_packages.verification import verify_archive
from specmate.firmware_builds import operations as firmware_operations
from specmate.firmware_builds.contracts import FirmwareRef
from specmate.firmware_builds.pack import recipe_for
from specmate.operations import ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_export_packages import download, review
from .test_firmware_builds import (  # noqa: F401 -- pytest fixtures
    IMAGE,
    attempt,
    board,
    compiler_recipe,
    fake_outputs,
    firmware,
    intake,
    recipe,
    requested,
    source,
    sources,
)
from .test_harnesses import capture as freeze_harness
from .test_harnesses import create as create_harness
from .test_harnesses import fixture as harness_fixture


def frozen_harness(users, project, mutate=None):
    _, _, _, harness = harness_fixture(users["owner"], project)
    harness = copy.deepcopy(harness)
    if mutate:
        mutate(harness)
    return freeze_harness(users["owner"], create_harness(users["owner"], project, harness))


def package(users, payload):
    reviewed = review(users["viewer"], payload)
    raw, files = download(users["viewer"], payload, reviewed)
    return reviewed, raw, files


def test_formboard_print_is_a_deterministic_server_output_from_exact_revisions(users, project):
    revision = frozen_harness(users, project)
    payload = {"root_revision_id": revision["revision_id"], "quantity": 2}
    reviewed, raw, files = package(users, payload)
    manifest = reviewed["manifest"]
    base = f"cable/{revision['revision_id']}"
    assert {f"{base}/formboard-print.html", f"{base}/formboard-plan.json"} <= set(files)
    output = next(o for o in manifest["outputs"] if o["kind"] == "harness_formboard_print")
    assert output["coherence"] == "coherent"
    # The harness itself is pinned; the stock it draws is cited exactly and never conflicts.
    cited = {c["revision_id"]: c["status"] for c in output["cited_revisions"]}
    assert cited[revision["revision_id"]] == "pinned" and "conflict" not in cited.values()
    assert {s["revision_id"] for s in output["anchor"]["stock_revisions"]} <= set(cited)
    assert output["scope_quantity"] == {"status": "known", "amount": 2, "per_root": 1}
    assert output["scale"] == "1:1" and output["calibration"] == "uncalibrated"
    # Hand-derived: sections of 100 and 40 mm on one row, one stub 12.8 mm past the
    # junction; width 140 mm plus 2 x 44.8 mm padding fits one 277 mm A4 window.
    plan = json.loads(files[f"{base}/formboard-plan.json"])
    assert (plan["rows"], plan["cols"], len(plan["pages"])) == (1, 1, 1)
    assert plan["paper"]["width_mm"] == 297 and plan["paper"]["height_mm"] == 210
    lengths = {s["section_id"]: s["drawn_length_mm"] for s in plan["sections"]}
    assert lengths == {"shared": 100, "branch": 40}
    html = files[f"{base}/formboard-print.html"].decode()
    assert "shared · 100 mm" in html and "branch · 40 mm" in html
    assert "<script" not in html and "http" not in html.replace("http://www.w3.org/2000/svg", "")
    assert not verify_archive(raw, reviewed["sha256"])
    ids = {u["id"] for u in manifest["unsupported"]}
    assert "cable.formboard_print" not in ids and "pcb.assembly_outputs" in ids
    again = package(users, payload)
    assert again[1] == raw and again[0]["sha256"] == reviewed["sha256"]


def test_long_board_is_tiled_and_unknown_length_is_labeled_not_measured(users, project):
    def longer(harness):
        harness["sections"][0]["planned_cut_length_mm"] = 600
        harness["sections"][1]["planned_cut_length_mm"] = None
        harness["sections"][1].pop("cut_basis", None)

    revision = frozen_harness(users, project, longer)
    reviewed, _, files = package(
        users, {"root_revision_id": revision["revision_id"], "quantity": 1}
    )
    base = f"cable/{revision['revision_id']}"
    plan = json.loads(files[f"{base}/formboard-plan.json"])
    # Hand-derived: placeholder 12 percent of 600 = 72 mm, so the board spans 0..672 mm;
    # 672 + 89.6 padding = 761.6 mm over 267 mm tile steps (277 window - 10 overlap) is 3 pages.
    assert (plan["cols"], plan["rows"]) == (3, 1)
    states = {s["section_id"]: s["length_status"] for s in plan["sections"]}
    assert states == {"shared": "recorded", "branch": "unknown"}
    html = files[f"{base}/formboard-print.html"].decode()
    assert "branch · length unknown" in html and html.count('class="page"') == 3
    output = next(
        o for o in reviewed["manifest"]["outputs"] if o["kind"] == "harness_formboard_print"
    )
    assert output["sections_with_unknown_length"] == 1 and output["coherence"] == "coherent"
    assert "unknown-length" in {w["code"] for w in plan["warnings"]}


def firmware_root(users, project, firmware, board, snapshot_assignment=True):
    owner = users["owner"]
    assignments = {"firmware_revision_id": firmware["revision_id"]} if snapshot_assignment else {}
    draft = op(
        owner,
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic repeated firmware boards",
            "assembly": {
                "occurrences": [
                    {
                        "local_id": local,
                        "revision_id": board[0]["revision_id"],
                        "assignments": assignments,
                    }
                    for local in ("left", "right")
                ]
            },
        },
    )
    return op(
        owner, "assembly.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


def approved_build(users, firmware, root, settings, path):
    ref = FirmwareRef(
        firmware_revision_id=firmware["revision_id"],
        assembly_snapshot_id=root["snapshot_id"] if path else None,
        path=path,
    )
    _, _, spec = firmware_operations.inputs(users["owner"], ref)
    item = recipe_for(spec, IMAGE)
    settings.SPECMATE_APPROVED_RECIPES = {item["id"]: item}
    result = op(
        users["owner"],
        "firmware_build.request",
        {
            **ref.model_dump(mode="json"),
            "recipe_id": item["id"],
            "source_execution_authorized": True,
            "basis": "Reviewed exact occurrence",
        },
        idempotency_key=f"export-{'-'.join(path) or 'plain'}",
    )
    stage = fake_outputs(result)
    return ref, result, stage


def test_firmware_outputs_are_packaged_with_hashes_handoff_and_rights(
    users, project, firmware, board, settings, compiler_recipe
):
    root = firmware_root(users, project, firmware, board)
    ref, result, stage = approved_build(users, firmware, root, settings, ["right"])
    build = {**ref.model_dump(mode="json"), "build_id": result["build_id"]}
    payload = {"root_revision_id": root["revision_id"], "quantity": 3, "firmware_builds": [build]}
    reviewed = review(users["viewer"], payload)
    manifest = reviewed["manifest"]
    output = next(o for o in manifest["outputs"] if o["kind"] == "firmware_build")
    assert output["findings"] == [] and output["coherence"] == "coherent"
    # Independent: the registered stage outputs are the source of expected bytes and hashes.
    registered = {o.path: o for o in stage.outputs.all()}
    base = f"firmware/{result['build_id']}"
    assert set(output["files"]) == {f"{base}/{path}" for path in registered}
    assert {"firmware.elf", "firmware.hex", "handoff.json", "compile.json"} <= set(registered)
    assert output["anchor"]["elf_sha256"] == registered["firmware.elf"].sha256
    assert output["anchor"]["hex_sha256"] == registered["firmware.hex"].sha256
    assert output["anchor"]["handoff_sha256"] == registered["handoff.json"].sha256
    assert output["anchor"]["occurrence"]["path"] == ["right"]
    assert output["flashing"] == "not_performed" and output["physical_qualification"] is False
    assert output["hardware_compatibility"] == "not_evaluated"
    # BLD-006: one accepted compile is provenance only, for the build and every file.
    assert output["reproducibility"]["level"] == "provenance"
    assert set(output["reproducibility"]["outputs"].values()) == {"provenance"}
    assert set(output["reproducibility"]["outputs"]) == set(registered)
    # The root assembly occurs once, so three units are in scope for the exact occurrence.
    assert output["scope_quantity"] == {"status": "known", "amount": 3, "per_root": 1}
    statuses = {c["revision_id"]: c["status"] for c in output["cited_revisions"]}
    assert statuses[firmware["revision_id"]] == "pinned" and set(statuses.values()) == {"pinned"}
    # Rights: the pinned source file's declared rights are listed as unknown, never cleared,
    # so download needs an explicit acknowledgement.
    rights = [r for r in manifest["rights"]["items"] if r["record"] == "firmware_source"]
    assert [(r["declared_rights"], r["rights_status"], r["source_path"]) for r in rights] == [
        ("MIT", "unknown", "main.c")
    ]
    assert manifest["rights"]["acknowledgement_required"] is True
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "export_package.download",
            {**payload, "reviewed_sha256": reviewed["sha256"]},
        )
    raw, files = download(users["viewer"], {**payload, "rights_acknowledged": True}, reviewed)
    for path, row in registered.items():
        from specmate.sources import blobstore

        with blobstore.open_blob(row.sha256) as stream:
            assert files[f"{base}/{path}"] == stream.read()
    assert not verify_archive(raw, reviewed["sha256"])
    ids = {u["id"] for u in manifest["unsupported"]}
    assert "firmware.build_outputs" not in ids and "pcb.assembly_outputs" in ids
    assert manifest["sections"]["firmware"]["builds"] == 1
    listed = op(
        users["viewer"], "export_package.candidates", {"root_revision_id": root["revision_id"]}
    )
    assert build in listed["firmware_builds"]


def test_firmware_build_without_a_pinned_firmware_revision_is_incoherent(
    users, project, firmware, board, settings, compiler_recipe
):
    with_firmware = firmware_root(users, project, firmware, board)
    ref, result, _ = approved_build(users, firmware, with_firmware, settings, [])
    bare = firmware_root(users, project, firmware, board, snapshot_assignment=False)
    payload = {
        "root_revision_id": bare["revision_id"],
        "quantity": 1,
        "firmware_builds": [{**ref.model_dump(mode="json"), "build_id": result["build_id"]}],
    }
    reviewed = review(users["viewer"], payload)
    output = next(o for o in reviewed["manifest"]["outputs"] if o["kind"] == "firmware_build")
    assert output["coherence"] == "incoherent"
    assert "firmware_not_pinned" in {f["reason"] for f in output["findings"]}
    assert reviewed["manifest"]["coherence"] == "incoherent"
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "export_package.download",
            {**payload, "reviewed_sha256": reviewed["sha256"], "rights_acknowledged": True},
        )


def test_pinned_firmware_without_an_included_build_is_limited_not_complete(
    users, project, firmware, board
):
    root = firmware_root(users, project, firmware, board)
    reviewed = review(users["viewer"], {"root_revision_id": root["revision_id"], "quantity": 1})
    manifest = reviewed["manifest"]
    assert {
        "output": "firmware",
        "revision_id": firmware["revision_id"],
        "reason": "no_registered_firmware_build_included",
    } in manifest["unresolved"]
    assert manifest["completeness"] == "limited"
    assert manifest["sections"]["firmware"]["status"] == "included"
    assert "workspace_id" not in json.dumps(manifest["sections"]["firmware"])
