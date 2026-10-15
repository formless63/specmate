"""Server-side formboard print: golden bytes from the TypeScript renderer plus hand values.

`tests/data/formboard/expected.json` is produced by `generate.ts` from the browser
renderer in `packages/harness-views`; the Python port must reproduce it exactly. The
independent expectations below are computed by hand from the synthetic harness
(trunk 500 mm, leg 250.5 mm, unknown leg at the labeled placeholder length).
"""

import json
from pathlib import Path

import pytest

from specmate.harnesses.formboard import (
    appearance_of,
    edge_color,
    formboard_layout,
    js,
    n2,
    plan_print,
    render_page_svg,
    render_print_html,
    section_layout,
)

DATA = Path(__file__).parent / "data" / "formboard"
INPUTS = json.loads((DATA / "inputs.json").read_text())
EXPECTED = json.loads((DATA / "expected.json").read_text())


def stocks():
    return {
        rid: {"name": INPUTS["names"][rid], "section": section_layout(spec)}
        for rid, spec in INPUTS["stocks"].items()
    }


def case(case_id):
    return next(c for c in INPUTS["cases"] if c["id"] == case_id)


@pytest.mark.parametrize("case_id", ["default", "variant"])
def test_python_print_matches_typescript_renderer_byte_for_byte(case_id):
    c = case(case_id)
    board = formboard_layout(c["harness"], stocks())
    plan = plan_print(board, c["title"], **c["settings"])
    want = EXPECTED[case_id]
    assert plan["ok"] is want["ok"]
    assert plan["scale_label"] == want["scale_label"]
    assert (plan["rows"], plan["cols"]) == (want["rows"], want["cols"])
    assert plan["full_scale_claim"] is want["full_scale_claim"]
    assert render_page_svg(plan, plan["pages"][0]) == want["page_one_svg"]
    assert render_print_html(plan) == want["html"]


def test_layout_matches_hand_computed_lengths_and_rows():
    board = formboard_layout(case("default")["harness"], stocks())
    bars = {b.section_id: b for b in board.bars}
    # Trunk 500 mm; leg A 250.5 mm continues the trunk's row from its far end.
    assert (bars["S1"].x0, bars["S1"].x1, bars["S1"].y) == (0, 500, 0)
    assert (bars["S2"].x0, bars["S2"].x1, bars["S2"].y) == (500, 750.5, 0)
    # S3 has no planned length: 12 percent of the longest known length, flagged unknown.
    assert (bars["S3"].x0, bars["S3"].x1, bars["S3"].y) == (500, 560, 16)
    assert bars["S3"].length_known is False and bars["S3"].length_text == "length unknown"
    assert bars["S1"].length_text == "500 mm" and bars["S2"].length_text == "250.5 mm"
    assert [j["breakout"] for j in board.junctions] == ["B1"]
    assert len(board.stubs) == 1 and board.stubs[0]["labels"] == ["Tap <b>"]
    # Outer diameters come from the stock rings: pair 4.2 mm, coax 3.2 mm.
    assert bars["S1"].outer_mm == pytest.approx(4.2) and bars["S2"].outer_mm == pytest.approx(3.2)


def test_default_print_is_a_declared_full_size_tiled_plan_and_is_deterministic():
    c = case("default")
    board = formboard_layout(c["harness"], stocks())
    plan = plan_print(board, c["title"])
    assert plan["full_scale_claim"] and plan["scale_label"] == "1:1"
    # Printable window on A4 landscape with 10 mm margins and the 22 mm footer.
    assert (plan["win_w"], plan["win_h"]) == (277, 168)
    # The drawing is wider than one window: tiles step by window minus the 10 mm overlap.
    assert plan["cols"] > 1 and plan["pages"][1]["tx"] == 267
    assert render_print_html(plan) == render_print_html(plan_print(board, c["title"]))
    reference = max(plan["references"], key=lambda r: r["recorded_mm"])
    assert reference["recorded_mm"] == 250.5 or reference["recorded_mm"] == 500
    # At 1:1 and no calibration the paper length equals the recorded length.
    assert all(r["paper_mm"] == r["recorded_mm"] for r in plan["references"])


def test_reduced_plans_never_claim_full_size_and_bad_inputs_are_errors():
    c = case("default")
    board = formboard_layout(c["harness"], stocks())
    ratio = plan_print(board, "x", mode="ratio", ratio_denominator=4)
    assert not ratio["full_scale_claim"] and ratio["scale_label"] == "1:4"
    assert "NOT full size" in " ".join(scale for scale in [*[w["text"] for w in ratio["warnings"]]])
    bad = plan_print(board, "x", measured_ruler_mm=50)
    assert not bad["ok"] and bad["pages"] == []
    with pytest.raises(ValueError):
        render_print_html(bad)


def test_unknown_stock_color_is_never_guessed_and_helpers_match_js_formatting():
    assert appearance_of("jacket", None, None)["fill_source"] == "unknown"
    assert appearance_of("jacket", "white/blue", "PVC")["stripe"] == "#1f5fbf"
    assert appearance_of("shield", None, "Tinned copper")["fill_source"] == "material-typical"
    assert edge_color("#000000") == "#737373"
    assert (js(5.0), js(-0.0), js(0.125), n2(1.005), n2(0.004)) == ("5", "0", "0.125", "1", "0")
