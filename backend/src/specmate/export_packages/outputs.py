"""Server-derived and retained outputs added to coherent export packages.

The formboard print is regenerated from the exact frozen harness revision and the exact
stock revisions it pins (deterministic, no clock, no browser). Firmware outputs are the
retained, validated compiler files of one registered build. Neither is a release,
manufacturing approval, device test or qualification.
"""

import json

from specmate.design.operations import canonical_bytes
from specmate.firmware_builds.operations import (
    output_bytes,
    scoped_build,
)
from specmate.firmware_builds.operations import validate_outputs as validate_firmware
from specmate.harnesses.formboard import (
    PAPERS,
    formboard_layout,
    plan_print,
    render_print_html,
    section_layout,
)
from specmate.harnesses.queries import read_revision
from specmate.wire_stock.schemas import StockSpecification

FORMBOARD_HTML = "formboard-print.html"
FORMBOARD_PLAN = "formboard-plan.json"
FORMBOARD_SETTINGS = {"paper": "a4", "orientation": "landscape", "margin_mm": 10, "overlap_mm": 10}


def label(revision):
    return f"{revision.definition.name} r{revision.number}"


def content(revision):
    return json.loads(bytes(revision.snapshot.canonical))["content"]


def formboard_print(user, revision_id):
    """Full-size (1:1) tiled formboard print of one exact harness revision.

    Returns the printable HTML bytes, a machine-readable plan, the exact stock revisions
    drawn, and `unavailable` (a plain reason) when the plan cannot be produced. Unknown
    cut lengths are drawn dashed at a labeled placeholder length, never as measurements.
    """
    revision, closure = read_revision(user, revision_id)
    harness = closure.harness.model_dump(mode="json")
    for section in harness["sections"]:
        value = section["planned_cut_length_mm"]
        section["planned_cut_length_mm"] = None if value is None else str(value)
    stocks = {}
    stock_pins = []
    for rid in sorted({str(s["stock_revision_id"]) for s in harness["sections"]}):
        stock = next(r for r in closure.revisions.values() if str(r.id) == rid)
        spec = StockSpecification.model_validate(content(stock)["stock"]).model_dump(mode="json")
        stocks[rid] = {"name": label(stock), "section": section_layout(spec)}
        stock_pins.append(
            {
                "revision_id": rid,
                "definition_id": str(stock.definition_id),
                "snapshot_sha256": stock.snapshot.sha256,
            }
        )
    base = {"stock_pins": stock_pins, "paper": FORMBOARD_SETTINGS["paper"]}
    if not harness["sections"]:
        return {**base, "unavailable": "no_physical_sections"}
    board = formboard_layout(harness, stocks)
    plan = plan_print(board, label(revision), **FORMBOARD_SETTINGS)
    if not plan["ok"]:
        errors = [w["text"] for w in plan["warnings"] if w["severity"] == "error"]
        return {**base, "unavailable": "print_plan_failed", "detail": errors}
    summary = {
        "format": "specmate.formboard-print-plan/1",
        "harness_revision_id": str(revision.id),
        "harness_snapshot_sha256": revision.snapshot.sha256,
        "scale": plan["scale_label"],
        "full_scale_claim": plan["full_scale_claim"],
        "scaled_axis": "length_only",
        "paper": {
            "id": FORMBOARD_SETTINGS["paper"],
            "orientation": FORMBOARD_SETTINGS["orientation"],
            "width_mm": PAPERS[FORMBOARD_SETTINGS["paper"]][1],
            "height_mm": PAPERS[FORMBOARD_SETTINGS["paper"]][0],
            "margin_mm": FORMBOARD_SETTINGS["margin_mm"],
            "overlap_mm": FORMBOARD_SETTINGS["overlap_mm"],
        },
        "calibration": {"measured_mm": None, "status": "uncalibrated"},
        "rows": plan["rows"],
        "cols": plan["cols"],
        "pages": [{"index": p["index"], "row": p["row"], "col": p["col"]} for p in plan["pages"]],
        "sections": [
            {
                "section_id": b.section_id,
                "stock_revision_id": b.stock_revision_id,
                "length_status": "recorded" if b.length_known else "unknown",
                "length_text": b.length_text,
                "drawn_length_mm": b.x1 - b.x0,
            }
            for b in board.bars
        ],
        "references": [
            {"section_id": r["section_id"], "recorded_mm": r["recorded_mm"]}
            for r in plan["references"]
        ],
        "warnings": [{"code": w["code"], "severity": w["severity"]} for w in plan["warnings"]],
        "layout_notes": board.notes,
        "routing_implied": False,
        "manufacturing_approval": False,
    }
    return {
        **base,
        "unavailable": None,
        "html": render_print_html(plan).encode(),
        "plan": canonical_bytes(summary),
        "summary": summary,
        "unknown_lengths": sum(1 for b in board.bars if not b.length_known),
        "pages": len(plan["pages"]),
    }


def firmware_build(ctx, ref):
    """One registered, fully validated compiler build and its exact retained bytes."""
    revision, spec, build = scoped_build(ctx, ref)
    report, outputs = validate_firmware(spec, build)
    raw = {path: output_bytes(output) for path, output in sorted(outputs.items())}
    return {
        "revision": revision,
        "spec": spec,
        "build": build,
        "report": report,
        "outputs": outputs,
        "raw": raw,
    }
