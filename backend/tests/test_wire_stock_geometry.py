"""Shared stock placement and fit findings, cross-checked with the TypeScript layout."""

import copy
import json
import math
from pathlib import Path

import pytest

from specmate.operations import ValidationFailed
from specmate.wire_stock.geometry import TOLERANCE_MM, evaluate, positions
from specmate.wire_stock.queries import get_stock
from specmate.wire_stock.schemas import StockSpecification

from .conftest import op
from .scope_helpers import workspace_of

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
CROSS_CHECK = json.loads((FIXTURES / "wire-stock-placement.json").read_text())


def case_stock(case):
    if "fixture" in case:
        return json.loads((FIXTURES / case["fixture"]).read_text())["stock"]
    return case["stock"]


def case(name):
    return next(c for c in CROSS_CHECK["cases"] if c["name"] == name)


@pytest.mark.parametrize("entry", CROSS_CHECK["cases"], ids=lambda c: c["name"])
def test_cross_check_fixture_positions_and_findings(entry):
    stock = case_stock(entry)
    # Every case is a valid stored construction: findings never replace schema validation.
    StockSpecification.model_validate(stock)
    expected = entry["expected"]
    placed = positions(stock)
    assert placed.keys() == expected["positions"].keys()
    for path, xy in expected["positions"].items():
        if xy is None:
            assert placed[path] is None, path
        else:
            assert placed[path] == pytest.approx(xy, abs=1e-9), path
    report = evaluate(stock)
    assert report["tolerance_mm"] == CROSS_CHECK["tolerance_mm"] == TOLERANCE_MM
    assert (report["status"], report["checks"]) == (expected["status"], expected["checks"])
    found = [
        {k: f[k] for k in ("code", "status", "paths", "excess_mm", "message")}
        for f in report["findings"]
    ]
    assert found == expected["findings"]


def test_double_placement_is_reported_with_independent_arithmetic():
    """Linear pitch 1.4 puts cores at +/-0.7; the extra +/-0.7 offsets move them to +/-1.4."""
    stock = case("double-placed shielded two-core")["stock"]
    assert positions(stock)["stock.pair.c2.conductor"] == pytest.approx([1.4, 0.0])
    report = evaluate(stock)
    fails = {tuple(f["paths"]): f for f in report["findings"] if f["status"] == "fail"}
    # Core outer radius 0.65 at 1.4 reaches 2.05; the screen bore radius is 1.35.
    assert fails[("stock.pair.c2", "stock.screen")]["excess_mm"] == pytest.approx(2.05 - 1.35)
    assert fails[("stock.pair.c2", "stock.screen")]["code"] == "containment"
    # The jacket bore radius is 1.7.
    assert fails[("stock.pair.c1", "stock.jacket")]["excess_mm"] == pytest.approx(2.05 - 1.7)
    # Drain radius 0.2 centred 1.5 below centre reaches 1.7, past the 1.35 screen bore.
    assert fails[("stock.drain", "stock.screen")]["excess_mm"] == pytest.approx(0.35)
    notes = [f["paths"][0] for f in report["findings"] if f["code"] == "offset_on_arranged"]
    assert notes == ["stock.pair.c1", "stock.pair.c2"]
    assert report["status"] == "problems"


def test_touching_layers_pass_within_tolerance_and_unknowns_never_pass():
    stock = copy.deepcopy(case("laid-up shielded two-core")["stock"])
    assert evaluate(stock)["status"] == "ok"
    # Insulation exactly at the screen bore is touching, not interference.
    stock["structure"]["children"][0]["pitch_mm"] = 1.3 + TOLERANCE_MM / 2
    assert evaluate(stock)["failed"] == 0
    stock["structure"]["children"][1]["inner_diameter_mm"] = None
    report = evaluate(stock)
    assert report["status"] == "incomplete"
    unknown = [f for f in report["findings"] if f["status"] == "not_evaluated"]
    assert unknown and all(f["excess_mm"] is None for f in unknown)
    assert all("stock.screen" in f["paths"] for f in unknown)


def test_ring_order_matches_the_drawing_direction():
    ccw = positions(case("three-core ring counterclockwise")["stock"])
    radius = 1.501 / 2
    assert ccw["stock.cores.c1.conductor"] == pytest.approx([0, -radius], abs=1e-12)
    step = -2 * math.pi / 3
    expected = [radius * math.cos(-math.pi / 2 + step), radius * math.sin(-math.pi / 2 + step)]
    assert ccw["stock.cores.c2.conductor"] == pytest.approx(expected)


def two_core(*, doubled):
    return copy.deepcopy(
        case("double-placed shielded two-core" if doubled else "laid-up shielded two-core")["stock"]
    )


def create(users, project, stock):
    return op(
        users["owner"],
        "wire_stock.create",
        {"workspace_id": workspace_of(project), "name": "Synthetic two-core", "stock": stock},
    )


def test_records_carry_findings_and_freeze_requires_acknowledgement(users, project):
    record = create(users, project, two_core(doubled=True))
    assert record["geometry"]["status"] == "problems"
    assert get_stock(users["viewer"], record["draft_id"])["geometry"] == record["geometry"]
    with pytest.raises(ValidationFailed) as refused:
        op(
            users["owner"],
            "wire_stock.freeze",
            {"draft_id": record["draft_id"]},
            expected_state=record["state"],
        )
    assert refused.value.details["geometry"]["failed"] == 5
    frozen = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": record["draft_id"], "acknowledge_geometry_findings": True},
        expected_state=record["state"],
    )
    assert frozen["geometry"]["failed"] == 5
    assert frozen["revision_id"]


def test_saving_with_findings_is_allowed_and_a_fitting_stock_freezes_plainly(users, project):
    record = create(users, project, two_core(doubled=True))
    updated = op(
        users["owner"],
        "wire_stock.update",
        {"draft_id": record["draft_id"], "stock": two_core(doubled=False)},
        expected_state=record["state"],
    )
    assert updated["geometry"]["status"] == "ok"
    frozen = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": record["draft_id"]},
        expected_state=updated["state"],
    )
    assert frozen["geometry"]["status"] == "ok"


def test_unknown_geometry_does_not_need_acknowledgement(users, project):
    record = create(users, project, copy.deepcopy(case("unknown pitch and unknown bore")["stock"]))
    assert record["geometry"]["status"] == "incomplete"
    frozen = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": record["draft_id"]},
        expected_state=record["state"],
    )
    assert frozen["geometry"]["not_evaluated"] > 0
