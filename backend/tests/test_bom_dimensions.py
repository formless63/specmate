"""Original synthetic arithmetic; no native or physical qualification."""

import copy
from decimal import localcontext

import pytest

from specmate.bom.queries import inspect_revision
from specmate.design.models import Definition, Snapshot
from specmate.operations import ValidationFailed

from .test_bom import capture, create, fixture, part


def quantity(amount, unit):
    return {"status": "unknown" if amount is None else "known", "amount": amount, "unit": unit}


def demand(path, revision, amount="1250", unit="mm", waste="25", waste_unit="cm"):
    return {
        "path": path,
        "revision_id": revision["revision_id"],
        "quantity": quantity(amount, unit),
        "basis": "Original synthetic net demand per root assembly",
        "waste": {"quantity": quantity(waste, waste_unit), "basis": "Explicit additive allowance"},
    }


def freeze(user, project, plan):
    return capture(user, create(user, project, plan), "bom.freeze")


def test_repeated_exact_lengths_waste_and_structural_counts(users, project):
    user = users["owner"]
    component, board, _, plan = fixture(user, project)
    plan["quantity"]["amount"] = 3
    plan["occurrence_demands"] = [
        demand(["left"], board),
        demand(["right", "resistor"], component, "250", "mm", "0", "m"),
    ]
    with localcontext() as ctx:
        ctx.prec = 2
        frozen = freeze(user, project, plan)
        view = inspect_revision(user, frozen["revision_id"])
    left, right = view["rows"]
    assert left["net_quantity"] == quantity("3.75", "m")
    assert left["waste_quantity"] == quantity("0.75", "m")
    assert left["required_quantity"] == quantity("4.5", "m")
    assert right["required_quantity"] == quantity("0.75", "m")
    assert left["quantity"] == left["net_quantity"]
    assert left["structural_quantity"] == quantity(3, "ea")
    assert left["per_root_quantity"] == quantity("1250", "mm")
    contents = inspect_revision(user, frozen["revision_id"], "assembly_contents")
    assert all(row["quantity"] == quantity(3, "ea") for row in contents["rows"])
    assert contents["rows"][0]["net_quantity"] == left["net_quantity"]


def test_process_mass_needs_separate_and_unknown_waste_not_zero(users, project):
    user = users["owner"]
    *_, plan = fixture(user, project)
    material = part(user, project, "Synthetic process compound")
    plan["quantity"]["amount"] = 4
    plan["needs"] = [
        {
            "local_id": "compound",
            "context_path": ["right"],
            "revision_id": material["revision_id"],
            "purpose": "consumables",
            "quantity": quantity("12.5", "g"),
            "basis": "Declared mass per root",
            "waste": {"quantity": quantity(None, "kg"), "basis": "Waste unknown"},
        }
    ]
    frozen = freeze(user, project, plan)
    row = inspect_revision(user, frozen["revision_id"], "consumables")["rows"][0]
    assert row["quantity"] == quantity("0.05", "kg")
    assert row["required_quantity"] == quantity(None, "kg")
    assert row["structural_quantity"] is None
    assert row["waste_status"] == "declared"
    assert all(
        r["need_id"] is None
        for r in inspect_revision(user, frozen["revision_id"], "assembly_contents")["rows"]
    )
    plan["needs"][0]["waste"]["quantity"] = quantity("2.5", "g")
    updated = freeze(user, project, plan)
    row = inspect_revision(user, updated["revision_id"], "consumables")["rows"][0]
    assert row["required_quantity"] == quantity("0.06", "kg")
    assert (
        inspect_revision(user, frozen["revision_id"], "consumables")["rows"][0][
            "required_quantity"
        ]["amount"]
        is None
    )


@pytest.mark.parametrize("net,waste,root_count", [(None, "1", 2), ("3", None, 2), ("3", "1", None)])
def test_unknowns_propagate_independently(users, project, net, waste, root_count):
    user = users["owner"]
    _, board, _, plan = fixture(user, project)
    plan["quantity"] = {
        "status": "unknown" if root_count is None else "known",
        "amount": root_count,
    }
    plan["occurrence_demands"] = [demand(["left"], board, net, "m", waste, "m")]
    row = inspect_revision(user, freeze(user, project, plan)["revision_id"])["rows"][0]
    assert row["required_quantity"]["amount"] is None
    assert row["net_quantity"]["amount"] == (None if net is None or root_count is None else "6")
    assert row["waste_quantity"]["amount"] == (None if waste is None or root_count is None else "2")


def test_absent_waste_preserves_whole_item_net_without_gross(users, project):
    user = users["owner"]
    *_, plan = fixture(user, project)
    row = inspect_revision(user, freeze(user, project, plan)["revision_id"])["rows"][0]
    assert row["quantity"] == quantity(1, "ea")
    assert row["waste_status"] == "not_evaluated"
    assert row["required_quantity"] == quantity(None, "ea")


@pytest.mark.parametrize(
    "change",
    [
        {"quantity": quantity(1.5, "m")},
        {"quantity": quantity(True, "m")},
        {"quantity": quantity("0.1", "ea")},
        {"quantity": quantity("0", "m")},
        {"quantity": quantity("-1", "m")},
        {"quantity": quantity("1e99", "m")},
        {"quantity": quantity("0.000000001", "mm")},
        {"quantity": quantity("NaN", "m")},
        {"waste": {"quantity": quantity("1", "kg"), "basis": "Wrong dimension"}},
        {"waste": {"quantity": quantity("-1", "m"), "basis": "Negative"}},
        {"waste": {"quantity": quantity("0", "m"), "basis": ""}},
        {"path": ["missing"]},
    ],
)
def test_invalid_demand_rolls_back(users, project, change):
    user = users["owner"]
    _, board, _, plan = fixture(user, project)
    entry = demand(["left"], board)
    entry.update(change)
    plan["occurrence_demands"] = [entry]
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(user, project, plan)
    assert Definition.objects.count() == before


@pytest.mark.parametrize(
    "net,waste,root_count", [("999999999999999", "0", 2), ("999999999999999", "999999999999999", 1)]
)
def test_derived_product_sum_overflow_without_rounding(users, project, net, waste, root_count):
    user = users["owner"]
    _, board, _, plan = fixture(user, project)
    plan["quantity"]["amount"] = root_count
    plan["occurrence_demands"] = [demand(["left"], board, net, "m", waste, "m")]
    before = Snapshot.objects.count()
    with pytest.raises(ValidationFailed):
        create(user, project, plan)
    assert Snapshot.objects.count() == before


def test_duplicate_paths_and_bought_ancestor_suppression(users, project):
    user = users["owner"]
    component, board, _, plan = fixture(user, project)
    entry = demand(["left"], board)
    plan["occurrence_demands"] = [entry, copy.deepcopy(entry)]
    with pytest.raises(ValidationFailed):
        create(user, project, plan)
    plan["occurrence_demands"] = [entry, demand(["left", "resistor"], component)]
    plan["scope_paths"] = [["left", "resistor"]]
    view = inspect_revision(user, freeze(user, project, plan)["revision_id"])
    assert view["rows"] == []
    assert view["boundaries"][0]["address"]["path"] == ["left"]


def test_same_revision_repeated_paths_keep_distinct_demands_and_policy_basis(users, project):
    user = users["owner"]
    _, board, _, plan = fixture(user, project)
    plan["policies"][2]["decision"] = "buy"
    plan["quantity"]["amount"] = 2
    plan["occurrence_demands"] = [
        demand(["left"], board, "500", "mm", "0", "m"),
        demand(["right"], board, "1500", "mm", "100", "mm"),
    ]
    view = inspect_revision(user, freeze(user, project, plan)["revision_id"])
    assert [
        (r["address"]["path"], r["revision_id"], r["required_quantity"]["amount"])
        for r in view["rows"]
    ] == [
        (["left"], board["revision_id"], "1"),
        (["right"], board["revision_id"], "3.2"),
    ]
    assert all(r["basis"] == "Explicit synthetic planning decision" for r in view["rows"])
    assert all(
        r["demand_basis"] == "Original synthetic net demand per root assembly" for r in view["rows"]
    )


def test_convert_representable_trailing_zero_precision_exactly(users, project):
    user = users["owner"]
    _, board, _, plan = fixture(user, project)
    plan["occurrence_demands"] = [demand(["left"], board, "1.000000000", "mm", "0.000000000", "mm")]
    row = inspect_revision(user, freeze(user, project, plan)["revision_id"])["rows"][0]
    assert row["per_root_quantity"] == quantity("1.000000000", "mm")
    assert row["required_quantity"] == quantity("0.001", "m")


@pytest.mark.parametrize("target", ["net", "waste"])
def test_nonblank_declaration_basis_required(users, project, target):
    user = users["owner"]
    _, board, _, plan = fixture(user, project)
    entry = demand(["left"], board)
    if target == "net":
        entry["basis"] = "   "
    else:
        entry["waste"]["basis"] = "   "
    plan["occurrence_demands"] = [entry]
    with pytest.raises(ValidationFailed):
        create(user, project, plan)
