"""Independent exact ledger-return and attribution oracles for PRE-003."""

import copy
from decimal import Decimal

import pytest

from specmate.access.models import WorkspaceMember
from specmate.design.models import Snapshot
from specmate.inventory.models import StockEntry
from specmate.material_accounting.queries import inspect_revision
from specmate.operations import NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_inventory import open_account, reserve
from .test_inventory_consumption import create_work, give_back, use
from .test_material_accounting import create, fixture, freeze, quantity
from .test_preparation import cable


def setup(user, users, project, stock, subject):
    lot = op(
        user, "catalog.register_lot", {"revision_id": stock, "label": "Synthetic ledger stock"}
    )
    location = op(
        user,
        "inventory.create_location",
        {"workspace_id": workspace_of(project), "name": "Synthetic ledger bench"},
    )
    account = open_account(users, lot, location, dimension="length", amount="10", unit="m")
    issued = use(
        user, reserve(user, account, "3", unit="m"), create_work(user, subject), "3", unit="m"
    )
    return account, issued


def record(issued):
    return {
        "consumption_ids": [issued["consumption"]["entry_id"]],
        "retained": quantity("280", "cm"),
        "waste": quantity("10", "cm"),
        "basis": "Independent exact observations",
    }


def test_frozen_observations_read_later_returns_without_mutation(users, project):
    user = users["owner"]
    value, subject, _, plan = fixture(user, project)
    _, issued = setup(user, users, project, value["stock_revision_id"], subject["revision_id"])
    plan["quantity"] = 999
    plan["pieces"][0]["reconciliation"] = record(issued)
    captured = freeze(user, create(user, project, plan))
    canonical = bytes(Snapshot.objects.get(id=captured["snapshot_id"]).canonical)
    before = inspect_revision(user, captured["revision_id"])["pieces"][0]["reconciliation"]
    assert (
        Decimal(before["issued"]) == 300
        and Decimal(before["returned"]) == 0
        and Decimal(before["unallocated"]) == 10
    )
    give_back(user, issued, "0.1", unit="m")
    count = StockEntry.objects.count()
    after = inspect_revision(user, captured["revision_id"])["pieces"][0]["reconciliation"]
    assert (
        Decimal(after["returned"]) == 10
        and Decimal(after["net_issued"]) == 290
        and after["status"] == "balanced"
    )
    assert after["record"] == before["record"] and after["record"]["retained"]["amount"] == "280"
    assert (
        StockEntry.objects.count() == count
        and bytes(Snapshot.objects.get(id=captured["snapshot_id"]).canonical) == canonical
    )


def test_hidden_latest_account_work_precedes_competing_section_diagnostic(users, project):
    user = users["owner"]
    value, subject, _, plan = fixture(user, project)
    _, issued = setup(user, users, project, value["stock_revision_id"], subject["revision_id"])
    plan["pieces"][0]["reconciliation"] = record(issued)
    draft = create(user, project, plan, idempotency_key="independent-retained")
    captured = freeze(user, draft)
    hidden = op(user, "project.create", {"name": "Synthetic hidden current assertion"})[
        "project_id"
    ]
    other_value, _ = cable(user, hidden)
    other_draft = op(
        user,
        "cable.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Same-project work with hidden dependency",
            "cable": other_value,
        },
    )
    other = op(
        user,
        "cable.freeze",
        {"draft_id": other_draft["draft_id"]},
        expected_state=other_draft["state"],
    )
    use(
        user,
        reserve(user, issued["account"], "1", unit="m"),
        create_work(user, other["revision_id"], key="other-work"),
        "1",
        unit="m",
        key="other-consumption",
    )
    WorkspaceMember.objects.filter(workspace__projects=hidden, user=user).delete()
    bad = copy.deepcopy(plan)
    bad["pieces"][0]["section_id"] = "not-a-cable-section"
    with pytest.raises((NotFound, PermissionDenied)):
        create(user, project, bad)
    with pytest.raises((NotFound, PermissionDenied)):
        inspect_revision(user, captured["revision_id"])
    supplied = copy.deepcopy(plan)
    supplied["pieces"][0]["reconciliation"] = None
    with pytest.raises((NotFound, PermissionDenied)):
        create(user, project, supplied, idempotency_key="independent-retained")


def test_same_event_cannot_count_twice(users, project):
    user = users["owner"]
    value, subject, _, plan = fixture(user, project)
    _, issued = setup(user, users, project, value["stock_revision_id"], subject["revision_id"])
    plan["pieces"][0]["reconciliation"] = record(issued)
    plan["pieces"][0]["reconciliation"]["consumption_ids"] *= 2
    count = StockEntry.objects.count()
    with pytest.raises(ValidationFailed):
        create(user, project, plan)
    assert StockEntry.objects.count() == count
