"""PRE-003 original independent material and ledger oracles."""

import copy
from decimal import Decimal
from uuid import UUID

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from specmate.access.models import Membership
from specmate.design.models import Definition, Snapshot
from specmate.inventory.models import StockEntry
from specmate.material_accounting.queries import inspect_revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
)

from .conftest import op
from .test_design import freeze as freeze_generic
from .test_harnesses import capture as capture_harness
from .test_harnesses import create as create_harness
from .test_harnesses import fixture as harness_fixture
from .test_inventory import open_account, reserve
from .test_inventory_consumption import create_work, give_back, use
from .test_preparation import (
    cable,
    evidence,
    profile,
)
from .test_preparation import (
    create as create_profile,
)
from .test_preparation import (
    freeze as freeze_profile,
)


def quantity(amount, unit="mm"):
    return {"amount": amount, "unit": unit, "status": "unknown" if amount is None else "known"}


def extent(amount):
    return {"amount_mm": amount, "basis": "Independent synthetic material declaration"}


def fixture(user, project):
    value, subject = cable(user, project)
    recipe = freeze_profile(
        user, create_profile(user, project, profile(value["stock_revision_id"]))
    )
    plan = {
        "subject_revision_id": subject["revision_id"],
        "quantity": 2,
        "decision": "make",
        "decision_basis": "Synthetic bench build decision",
        "pieces": [
            {
                "installed": extent("1000"),
                "extra_waste": extent("5"),
                "cut_basis": "preparation_suggestion",
                "profile_revision_id": recipe["revision_id"],
            }
        ],
    }
    return value, subject, recipe, plan


def create(user, project, plan, **ctx):
    return op(
        user,
        "material_plan.create",
        {"project_id": project, "name": "Synthetic material sheet", "plan": plan},
        **ctx,
    )


def freeze(user, draft, **ctx):
    return op(
        user,
        "material_plan.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def test_exact_material_cut_allowances_procurement_history_and_http(users, project):
    user = users["owner"]
    value, subject, recipe, plan = fixture(user, project)
    draft = create(user, project, plan, idempotency_key="plan")
    assert create(user, project, plan, idempotency_key="plan") == draft
    captured = freeze(user, draft, idempotency_key="freeze")
    result = inspect_revision(users["viewer"], captured["revision_id"])
    row = result["pieces"][0]
    assert row["installed_mm"] == "1000" and row["installed_total_mm"] == "2000"
    assert row["cut_mm"] == "1035" and row["cut_total_mm"] == "2070"
    assert row["cut_minus_installed_mm"] == "35"  # unclassified, NOT claimed scrap
    assert row["extra_waste_total_mm"] == "10"
    assert row["procurement_mm"] == "2080"  # 2*(1035+5), never installed+cut+allowances
    assert [a["amount_mm"] for a in row["preparation"]["formula"]["allowances"]] == [
        "20",
        "10",
        "5",
    ]
    assert row["preparation"]["profile_revision_id"] == recipe["revision_id"]
    assert row["stock_revision_id"] == value["stock_revision_id"]
    assert result["ledger_written"] is False and StockEntry.objects.count() == 0
    snap = Snapshot.objects.get(id=captured["snapshot_id"])
    before = bytes(snap.canonical)
    assert set(snap.dependencies.values_list("revision_id", flat=True)) == {
        UUID(subject["revision_id"]),
        UUID(recipe["revision_id"]),
    }
    changed = copy.deepcopy(plan)
    changed["pieces"][0]["extra_waste"]["amount_mm"] = "5.000001"
    updated = op(
        user,
        "material_plan.update",
        {"draft_id": draft["draft_id"], "plan": changed},
        expected_state=captured["draft"]["state"],
    )
    later = freeze(user, updated)
    assert (
        inspect_revision(user, later["revision_id"])["pieces"][0]["procurement_mm"] == "2080.000002"
    )
    assert inspect_revision(user, captured["revision_id"]) == result
    assert bytes(Snapshot.objects.get(id=snap.id).canonical) == before
    with pytest.raises(Conflict):
        op(
            user,
            "material_plan.update",
            {"draft_id": draft["draft_id"], "plan": plan},
            expected_state=draft["state"],
        )
    with pytest.raises(IdempotencyMismatch):
        create(user, project, changed, idempotency_key="plan")
    client = Client()
    client.force_login(users["viewer"])
    response = client.get(f"/api/v0/material-accounting/revisions/{captured['revision_id']}")
    assert response.status_code == 200, response.content
    assert response.json() == result
    assert (
        op(users["viewer"], "material_plan.read", {"revision_id": captured["revision_id"]})
        == result
    )


@pytest.mark.parametrize("missing", ["installed", "waste", "cut", "quantity"])
def test_unknowns_independent_never_zero(users, project, missing):
    user = users["owner"]
    _, _, _, plan = fixture(user, project)
    if missing == "quantity":
        plan["quantity"] = None
    elif missing == "cut":
        # Declared stock cut is independently known; unreviewed profile isn't a fallback.
        # Replace with a valid unreviewed exact-stock profile.
        from specmate.preparation.queries import inspect_profile

        stock = inspect_profile(user, plan["pieces"][0]["profile_revision_id"])["profile"][
            "stock_revision_id"
        ]
        rules = profile(stock)
        rules["formulas"][0]["review"] = "unreviewed"
        recipe = freeze_profile(user, create_profile(user, project, rules))
        plan["pieces"][0]["profile_revision_id"] = recipe["revision_id"]
    else:
        plan["pieces"][0]["installed" if missing == "installed" else "extra_waste"]["amount_mm"] = (
            None
        )
    row = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])[
        "pieces"
    ][0]
    assert row["installed_mm"] == (None if missing == "installed" else "1000")
    assert row["cut_mm"] == (None if missing == "cut" else "1035")
    assert row["procurement_mm"] == ("2080" if missing == "installed" else None)


@pytest.mark.parametrize("decision", ["buy", "unknown"])
def test_bought_boundaries_exclude_cut_and_process_procurement(users, project, decision):
    user = users["owner"]
    _, _, _, plan = fixture(user, project)
    plan["decision"] = decision
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["pieces"][0]["cut_total_mm"] == "2070"
    assert result["pieces"][0]["procurement_mm"] is None
    assert result["purchased_subject_quantity"] == (2 if decision == "buy" else None)


def test_harness_one_shared_piece_not_visible_segment_count(users, project):
    user = users["owner"]
    stock, _, _, harness = harness_fixture(user, project)
    harness["sections"][0]["planned_cut_length_mm"] = "500"
    subject = capture_harness(user, create_harness(user, project, harness))
    rules = profile(stock["revision_id"], "stock_cut")
    recipe = freeze_profile(user, create_profile(user, project, rules))
    plan = {
        "subject_revision_id": subject["revision_id"],
        "quantity": 3,
        "decision": "make",
        "decision_basis": "Synthetic harness build",
        "pieces": [
            {
                "section_id": "shared",
                "installed": extent("300"),
                "extra_waste": extent("0"),
                "profile_revision_id": recipe["revision_id"],
                "cut_basis": "preparation_suggestion",
            }
        ],
    }
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["pieces"][0]["segment_ids"] == ["trunk", "leg-one"]
    # Fixture declares 500 mm + 35 mm recipe, THREE pieces not six segments.
    assert result["pieces"][0]["procurement_mm"] == "1605"
    assert result["unplanned_sections"] == ["branch"]


def consumable(user, project, plan, amount="0.25", waste="0.05"):
    item = op(
        user,
        "definition.create",
        {
            "project_id": project,
            "kind": "material",
            "name": "Synthetic process flux",
            "content": {},
        },
    )
    revision = freeze_generic(user, item["draft_id"], item["state"])
    plan["consumables"] = [
        {
            "local_id": "flux",
            "revision_id": revision["revision_id"],
            "quantity": quantity(amount, "g"),
            "basis": "Independent process requirement",
            "waste": {"quantity": quantity(waste, "g"), "basis": "Explicit process loss"},
        }
    ]
    return revision


def test_consumables_separate_unknown_and_no_retained_duplicate(users, project):
    user = users["owner"]
    value, _, _, plan = fixture(user, project)
    consumable(user, project, plan)
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["consumables"][0]["net_quantity"] == "0.50"
    assert result["consumables"][0]["waste_quantity"] == "0.10"
    assert result["consumables"][0]["procurement_quantity"] == "0.60"
    plan["consumables"][0]["waste"] = None
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["consumables"][0]["net_quantity"] == "0.50"
    assert result["consumables"][0]["procurement_quantity"] is None
    plan["consumables"][0]["revision_id"] = value["stock_revision_id"]
    with pytest.raises(ValidationFailed, match="duplicated"):
        create(user, project, plan)


def test_actual_inventory_reconciliation_returns_independent_batch_observations(users, project):
    user = users["owner"]
    value, subject, _, plan = fixture(user, project)
    lot = op(
        user,
        "catalog.register_lot",
        {"revision_id": value["stock_revision_id"], "label": "Synthetic material lot"},
    )
    location = op(
        user, "inventory.create_location", {"project_id": project, "name": "Synthetic bench"}
    )
    account = open_account(users, lot, location, dimension="length", amount="10", unit="m")
    reservation = reserve(user, account, "3", unit="m")
    work = create_work(user, subject["revision_id"])
    issued = use(user, reservation, work, "3", unit="m")
    returned = give_back(user, issued, "0.1", unit="m")
    record = {
        "consumption_ids": [issued["consumption"]["entry_id"]],
        "retained": quantity("2800"),
        "waste": quantity("100"),
        "basis": "Synthetic measured batch reconciliation",
    }
    plan["pieces"][0]["reconciliation"] = record
    count = StockEntry.objects.count()
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    actual = result["pieces"][0]["reconciliation"]
    assert Decimal(actual["issued"]) == Decimal("3000")
    assert Decimal(actual["returned"]) == Decimal("100")
    assert Decimal(actual["net_issued"]) == Decimal("2900")
    assert Decimal(actual["unallocated"]) == 0 and actual["status"] == "balanced"
    assert actual["record"]["retained"]["amount"] == "2800"  # NEVER multiplied by plan quantity=2
    assert StockEntry.objects.count() == count
    assert returned["account"]["physical_quantity"] == "7.1"
    record["waste"]["amount"] = "101"
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["pieces"][0]["reconciliation"]["status"] == "overallocated"
    record["retained"] = quantity(None)
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["pieces"][0]["reconciliation"]["status"] == "unknown"


def test_full_sources_revocation_precedes_cut_diagnostics_and_retained_replay(users, project):
    user = users["owner"]
    _, _, _, plan = fixture(user, project)
    hidden = op(user, "project.create", {"name": "Synthetic private material evidence"})[
        "project_id"
    ]
    original, _ = evidence(user, hidden)
    _, source = evidence(user, project, original)
    plan["pieces"][0]["extra_waste"]["source"] = source
    draft = create(user, project, plan, idempotency_key="protected")
    captured = freeze(user, draft)
    Membership.objects.filter(user=user, project_id=hidden).delete()
    supplied = copy.deepcopy(plan)
    supplied["pieces"][0]["extra_waste"]["source"] = None
    supplied["pieces"][0]["section_id"] = "missing-physical-section"
    with pytest.raises((NotFound, PermissionDenied), match="Project"):
        create(user, project, supplied, idempotency_key="protected")
    plan["pieces"][0]["extra_waste"]["source"]["path"] = "missing.txt"
    with pytest.raises((NotFound, PermissionDenied), match="Project"):
        create(user, project, plan)
    with pytest.raises((NotFound, PermissionDenied)):
        inspect_revision(user, captured["revision_id"])


def test_authority_diagnostics_generic_operations_and_rollback(users, project):
    user = users["owner"]
    _, _, _, plan = fixture(user, project)
    for actor in [users["viewer"], users["outsider"]]:
        with pytest.raises((NotFound, PermissionDenied)):
            create(actor, project, plan)
    count = Definition.objects.count()
    bad = copy.deepcopy(plan)
    bad["pieces"][0]["installed"]["amount_mm"] = 1.1
    with pytest.raises(ValidationFailed):
        create(user, project, bad)
    assert Definition.objects.count() == count
    draft = op(
        user,
        "definition.create",
        {
            "project_id": project,
            "kind": "material_plan",
            "name": "Generic material sheet",
            "content": {"material_plan": plan},
        },
    )
    captured = op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    assert Snapshot.objects.get(id=captured["snapshot_id"]).dependencies.count() == 2
    with pytest.raises((NotFound, PermissionDenied)):
        inspect_revision(users["outsider"], captured["revision_id"])
    get_user_model().objects.filter(pk=user.pk).update(is_active=False)
    assert user.is_active
    with pytest.raises(Unauthenticated):
        inspect_revision(user, captured["revision_id"])


def test_end_instructions_do_not_add_strip_lengths_to_stock_procurement(users, project):
    from .test_end_preparation import application
    from .test_end_preparation import create as create_ends
    from .test_end_preparation import freeze as freeze_ends
    from .test_end_preparation import profile as ends_profile

    user = users["owner"]
    value, subject, _, plan = fixture(user, project)
    ends = freeze_ends(user, create_ends(user, project, ends_profile(value["stock_revision_id"])))
    plan["end_preparation"] = application(subject, ends, mapping_review="reviewed")
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["pieces"][0]["procurement_mm"] == "2080"
    assert (
        result["end_preparation"]["ends"][0]["instructions"][0]["instruction"]["length"][
            "nominal_mm"
        ]
        == "12.500001"
    )
    assert result["end_preparation"]["ends"][1]["instructions"][0]["unresolved"] == [
        "minus_mm",
        "plus_mm",
    ]


def test_unknown_actual_issue_and_invalid_unit_roll_back_without_ledger_write(users, project):
    user = users["owner"]
    _, _, _, plan = fixture(user, project)
    plan["pieces"][0]["reconciliation"] = {
        "consumption_ids": [],
        "retained": quantity("1900"),
        "waste": quantity("20"),
        "basis": "Independent recorded amounts without an issue event",
    }
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    actual = result["pieces"][0]["reconciliation"]
    assert actual["net_issued"] is None and actual["status"] == "unknown"
    assert actual["record"]["retained"]["amount"] == "1900"
    assert StockEntry.objects.count() == 0
    plan["pieces"][0]["reconciliation"]["retained"] = quantity("1", "ea")
    count = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(user, project, plan)
    assert Definition.objects.count() == count and StockEntry.objects.count() == 0


def test_generic_material_facts_are_not_inferred_design_references(users, project):
    user = users["owner"]
    _, _, _, plan = fixture(user, project)
    item = op(
        user,
        "definition.create",
        {
            "project_id": project,
            "kind": "material",
            "name": "Synthetic process material",
            "content": {"revision_id": "vendor-label-revision-2"},
        },
    )
    revision = freeze_generic(user, item["draft_id"], item["state"])
    plan["consumables"] = [
        {
            "local_id": "process",
            "revision_id": revision["revision_id"],
            "quantity": quantity("1", "g"),
            "basis": "Synthetic process requirement",
            "waste": {"quantity": quantity("0", "g"), "basis": "Explicit zero"},
        }
    ]
    result = inspect_revision(user, freeze(user, create(user, project, plan))["revision_id"])
    assert result["consumables"][0]["procurement_quantity"] == "2"
