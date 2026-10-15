"""INV-005: frozen need + live stock + dated, reviewed offers. Costs stay optional."""

from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.db import DatabaseError, transaction

from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.sourcing.models import SupplierOffer
from specmate.sourcing.queries import report

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_bom import capture, create, fixture, part
from .test_transports import api

TODAY = date.today()


def day(offset):
    return (TODAY - timedelta(days=offset)).isoformat()


def make_sourced(users, project, waste=True):
    """A frozen BOM whose procurement rows are one board and one resistor."""
    owner = users["owner"]
    component, board, _root, plan = fixture(owner, project)
    if waste:
        plan["occurrence_demands"] = [
            {
                "path": path,
                "revision_id": rev["revision_id"],
                "quantity": {"status": "known", "amount": 1, "unit": "ea"},
                "basis": "Synthetic demand",
                "waste": {
                    "quantity": {"status": "known", "amount": 0, "unit": "ea"},
                    "basis": "No spare declared",
                },
            }
            for path, rev in ((["left"], board), (["right", "resistor"], component))
        ]
    frozen = capture(owner, create(owner, project, plan), "bom.freeze")
    return {"component": component, "board": board, "bom": frozen, "project": project}


@pytest.fixture
def sourced(users, project):
    return make_sourced(users, project)


def offer(users, sourced, revision, who="owner", **extra):
    payload = {
        "workspace_id": workspace_of(sourced["project"]),
        "revision_id": revision["revision_id"],
        "supplier": "Synthetic Supply",
        "source": "Synthetic emailed quote",
        "review_basis": "Compared against the quote PDF",
        "offered_on": day(2),
        **extra,
    }
    return op(users[who], "sourcing.record_offer", payload)


def read(users, sourced, who="owner", **extra):
    return op(
        users[who],
        "sourcing.report",
        {"revision_id": sourced["bom"]["revision_id"], **extra},
    )


def row(result, revision):
    return next(r for r in result["rows"] if r["revision_id"] == revision["revision_id"])


def stock(users, sourced, revision, amount):
    owner = users["owner"]
    workspace = workspace_of(sourced["project"])
    lot = op(
        owner,
        "catalog.register_lot",
        {"revision_id": revision["revision_id"], "label": "Synthetic lot"},
    )
    location = op(
        owner, "inventory.create_location", {"workspace_id": workspace, "name": "Shelf A"}
    )
    return op(
        owner,
        "inventory.open_stock",
        {
            "lot_id": lot["lot_id"],
            "location_id": location["location_id"],
            "dimension": "count",
            "quantity": None if amount is None else {"amount": amount, "unit": "ea"},
            "reason": "Synthetic opening",
            "assertion_source": "Synthetic count",
            "assertion_status": "declared",
        },
    )


def test_no_offers_no_stock_stays_unknown_and_build_sheet_is_unaffected(users, sourced):
    result = read(users, sourced)
    board = row(result, sourced["board"])
    assert board["required"] == {"status": "known", "amount": "1", "unit": "ea"}
    assert board["stock"]["status"] == "none_recorded"
    assert board["stock"]["available"]["status"] == "unknown"
    assert board["shortfall"]["status"] == "unknown"
    assert board["shortfall"]["reason"] == "stock_none_recorded"
    assert board["shortfall"]["at_most"] == "1"
    assert board["offer_status"] == "none_on_record"
    assert result["cost"]["status"] == "unknown"
    assert result["cost"]["totals"] == []
    # The frozen BOM itself needs no price, currency or offer.
    from specmate.bom.queries import inspect_revision

    assert inspect_revision(users["owner"], sourced["bom"]["revision_id"])["rows"]
    assert SupplierOffer.objects.count() == 0 and result["ledger_written"] is False


def test_undeclared_waste_keeps_gross_unknown_with_net_lower_bound(users, project):
    plain = make_sourced(users, project, waste=False)
    stock(users, plain, plain["board"], "0")
    board = row(read(users, plain), plain["board"])
    assert board["required"]["status"] == "unknown"
    assert board["net_required"]["amount"] == "1"
    assert board["shortfall"]["reason"] == "waste_allowance_not_declared"
    assert board["shortfall"]["at_least"] == "1"


def test_priced_offer_with_known_stock_computes_shortfall_cost_and_dates(users, sourced):
    stock(users, sourced, sourced["board"], "0")
    made = offer(
        users,
        sourced,
        sourced["board"],
        price={"amount": "12.50", "currency": "USD"},
        availability="in_stock",
        valid_until=(TODAY + timedelta(days=5)).isoformat(),
    )
    assert made["reviewed_by"]["username"] == "owner" and made["offered_on"] == day(2)
    board = row(read(users, sourced), sourced["board"])
    assert board["stock"]["status"] == "known" and board["stock"]["observed_at"]
    assert board["shortfall"]["amount"] == "1"
    (entry,) = board["offers"]
    assert entry["freshness"] == "current" and entry["age_days"] == 2
    assert entry["estimated_cost"] == {
        "status": "known",
        "amount": "12.5",
        "currency": "USD",
        "reason": None,
    }
    result = read(users, sourced)
    # The resistor row is still unpriced, so the total is partial rather than complete.
    assert result["cost"]["status"] == "partial"
    assert result["cost"]["totals"] == [{"currency": "USD", "amount": "12.5", "rows_priced": 1}]


def test_reserved_stock_is_subtracted_from_availability(users, sourced):
    account = stock(users, sourced, sourced["board"], "3")
    op(
        users["editor"],
        "inventory.reserve",
        {
            "account_id": account["account_id"],
            "quantity": {"amount": "3", "unit": "ea"},
            "purpose": "x",
        },
        expected_state=account["state"],
    )
    board = row(read(users, sourced), sourced["board"])
    assert board["stock"]["available"]["amount"] == "0"
    assert board["shortfall"]["amount"] == "1"


def test_unknown_balance_is_not_zero_and_not_a_shortfall(users, sourced):
    stock(users, sourced, sourced["board"], None)
    board = row(read(users, sourced), sourced["board"])
    assert board["stock"]["status"] == "unknown"
    assert board["stock"]["available"]["amount"] is None
    assert board["shortfall"]["status"] == "unknown"


def test_missing_price_and_currency_never_block_and_are_explained(users, sourced):
    stock(users, sourced, sourced["board"], "0")
    offer(users, sourced, sourced["board"])
    offer(users, sourced, sourced["board"], supplier="No currency", price={"amount": "4"})
    offer(users, sourced, sourced["board"], supplier="No amount", price={"currency": "EUR"})
    board = row(read(users, sourced), sourced["board"])
    reasons = {o["supplier"]: o["estimated_cost"]["reason"] for o in board["offers"]}
    assert reasons == {
        "Synthetic Supply": "price_unknown",
        "No currency": "currency_unknown",
        "No amount": "price_unknown",
    }
    assert board["offer_status"] == "no_usable_price"
    assert {o["freshness"] for o in board["offers"]} == {"unknown"}


def test_freshness_policy_expiry_and_as_of(users, sourced):
    stock(users, sourced, sourced["board"], "0")
    offer(
        users,
        sourced,
        sourced["board"],
        offered_on=day(40),
        price={"amount": "2", "currency": "USD"},
    )
    offer(
        users,
        sourced,
        sourced["board"],
        supplier="Expired",
        offered_on=day(10),
        valid_until=day(3),
        price={"amount": "1", "currency": "USD"},
    )
    result = read(users, sourced, max_age_days=30)
    states = {o["supplier"]: o["freshness"] for o in row(result, sourced["board"])["offers"]}
    assert states == {"Synthetic Supply": "stale", "Expired": "expired"}
    # Stale and expired prices are shown but never summed into totals.
    assert result["cost"]["totals"] == []
    assert row(result, sourced["board"])["offer_status"] == "no_usable_price"
    # Looking back to before the second offer existed hides it, reporting that it did.
    old = read(users, sourced, as_of=day(20))
    assert [o["supplier"] for o in row(old, sourced["board"])["offers"]] == ["Synthetic Supply"]
    assert old["offers_after_as_of"] == 1


def test_substitutes_are_visible_but_never_satisfy_the_need_or_totals(users, sourced):
    stock(users, sourced, sourced["board"], "0")
    other = part(users["owner"], sourced["project"], "Synthetic alternative")
    with pytest.raises(ValidationFailed):
        offer(users, sourced, other, substitute_for_revision_id=sourced["board"]["revision_id"])
    substitute = offer(
        users,
        sourced,
        other,
        substitute_for_revision_id=sourced["board"]["revision_id"],
        substitution_basis="Same footprint, unverified electrical equivalence",
        price={"amount": "1", "currency": "USD"},
    )
    board = row(read(users, sourced), sourced["board"])
    assert board["offers"] == [] and board["offer_status"] == "none_on_record"
    (entry,) = board["substitutes"]
    assert entry["offer_id"] == substitute["offer_id"]
    assert entry["counts_toward_need"] is False
    assert entry["substitution"]["basis"].startswith("Same footprint")
    assert read(users, sourced)["cost"]["totals"] == []


def test_cheapest_per_currency_without_mixing_and_supersession(users, sourced):
    stock(users, sourced, sourced["board"], "0")
    first = offer(users, sourced, sourced["board"], price={"amount": "9", "currency": "USD"})
    offer(users, sourced, sourced["board"], supplier="B", price={"amount": "7", "currency": "USD"})
    offer(users, sourced, sourced["board"], supplier="C", price={"amount": "5", "currency": "EUR"})
    result = read(users, sourced)
    assert result["cost"]["totals"] == [
        {"currency": "EUR", "amount": "5", "rows_priced": 1},
        {"currency": "USD", "amount": "7", "rows_priced": 1},
    ]
    newer = offer(
        users,
        sourced,
        sourced["board"],
        offered_on=day(1),
        price={"amount": "6", "currency": "USD"},
        supersedes_offer_id=first["offer_id"],
    )
    after = row(read(users, sourced), sourced["board"])
    assert first["offer_id"] not in {o["offer_id"] for o in after["offers"]}
    assert newer["offer_id"] in {o["offer_id"] for o in after["offers"]}
    assert read(users, sourced)["superseded_offers_hidden"] == 1
    with pytest.raises(Conflict):
        offer(
            users,
            sourced,
            sourced["board"],
            offered_on=day(1),
            supersedes_offer_id=first["offer_id"],
        )


def test_price_unit_conversion_and_mismatch(users, sourced):
    stock(users, sourced, sourced["board"], "0")
    offer(
        users, sourced, sourced["board"], price={"amount": "3", "currency": "USD", "per_unit": "m"}
    )
    board = row(read(users, sourced), sourced["board"])
    assert board["offers"][0]["estimated_cost"]["reason"] == "unit_mismatch"


def test_validation_future_dates_authority_and_replay(users, sourced, other_workspace):
    future = (TODAY + timedelta(days=1)).isoformat()
    with pytest.raises(ValidationFailed):
        offer(users, sourced, sourced["board"], offered_on=future)
    with pytest.raises(ValidationFailed):
        offer(users, sourced, sourced["board"], price={"amount": "-1"})
    with pytest.raises(ValidationFailed):
        offer(users, sourced, sourced["board"], review_basis=" ")
    # Recording needs item.create (contributor and above); viewers can still read the report.
    with pytest.raises(PermissionDenied):
        offer(users, sourced, sourced["board"], who="viewer")
    offer(users, sourced, sourced["board"], who="contributor")
    assert read(users, sourced, who="viewer")["rows"]
    with pytest.raises((NotFound, PermissionDenied)):
        read(users, sourced, who="outsider")
    with pytest.raises((NotFound, PermissionDenied)):
        op(
            users["outsider"],
            "sourcing.record_offer",
            {
                "workspace_id": other_workspace,
                "revision_id": sourced["board"]["revision_id"],
                "supplier": "x",
                "source": "x",
                "review_basis": "x",
                "offered_on": day(1),
            },
        )
    key = {"idempotency_key": "offer-key-1"}
    payload = {
        "workspace_id": workspace_of(sourced["project"]),
        "revision_id": sourced["board"]["revision_id"],
        "supplier": "Replay",
        "source": "s",
        "review_basis": "b",
        "offered_on": day(1),
    }
    one = op(users["owner"], "sourcing.record_offer", payload, **key)
    two = op(users["owner"], "sourcing.record_offer", payload, **key)
    assert one["offer_id"] == two["offer_id"]
    assert SupplierOffer.objects.filter(supplier="Replay").count() == 1
    remove_member(users["owner"], project=sourced["project"])
    with pytest.raises((NotFound, PermissionDenied)):
        op(users["owner"], "sourcing.record_offer", payload, **key)


def test_offers_are_immutable_in_the_database(users, sourced):
    made = offer(users, sourced, sourced["board"])
    with pytest.raises(DatabaseError), transaction.atomic():
        SupplierOffer.objects.filter(id=made["offer_id"]).update(supplier="changed")
    with pytest.raises(DatabaseError), transaction.atomic():
        SupplierOffer.objects.filter(id=made["offer_id"]).delete()


def test_http_listing_and_report(users, sourced):
    offer(users, sourced, sourced["board"], price={"amount": "2", "currency": "USD"})
    client = api(users["viewer"])
    workspace = workspace_of(sourced["project"])
    listing = client.get(f"/api/v0/sourcing/workspaces/{workspace}/offers")
    assert listing.status_code == 200 and listing.json()["offers"][0]["supplier"]
    body = client.get(f"/api/v0/sourcing/revisions/{sourced['bom']['revision_id']}?max_age_days=30")
    assert body.status_code == 200 and body.json()["max_age_days"] == 30
    assert Decimal(listing.json()["offers"][0]["price"]["amount"]) == Decimal("2")


def test_report_rejects_other_kinds(users, sourced):
    with pytest.raises(ValidationFailed):
        report(users["owner"], sourced["board"]["revision_id"])


def test_material_plan_demand_uses_length_stock_and_per_meter_price(users, project):
    from .test_material_accounting import consumable
    from .test_material_accounting import create as create_plan
    from .test_material_accounting import fixture as plan_fixture
    from .test_material_accounting import freeze as freeze_plan

    owner = users["owner"]
    value, _subject, _recipe, plan = plan_fixture(owner, project)
    flux = consumable(owner, project, plan)
    frozen = freeze_plan(owner, create_plan(owner, project, plan))
    workspace = workspace_of(project)
    lot = op(
        owner,
        "catalog.register_lot",
        {"revision_id": value["stock_revision_id"], "label": "Cable reel"},
    )
    location = op(
        owner, "inventory.create_location", {"workspace_id": workspace, "name": "Reel rack"}
    )
    op(
        owner,
        "inventory.open_stock",
        {
            "lot_id": lot["lot_id"],
            "location_id": location["location_id"],
            "dimension": "length",
            "quantity": {"amount": "1", "unit": "m"},
            "reason": "Synthetic opening",
            "assertion_source": "Synthetic measurement",
            "assertion_status": "declared",
        },
    )
    op(
        owner,
        "sourcing.record_offer",
        {
            "workspace_id": workspace,
            "revision_id": value["stock_revision_id"],
            "supplier": "Cable Co",
            "source": "Synthetic list",
            "review_basis": "Checked",
            "offered_on": day(1),
            "price": {"amount": "10", "currency": "USD", "per_unit": "m"},
        },
    )
    result = op(owner, "sourcing.report", {"revision_id": frozen["revision_id"]})
    cable_row = row(result, {"revision_id": value["stock_revision_id"]})
    assert cable_row["required"] == {"status": "known", "amount": "2.08", "unit": "m"}
    assert cable_row["shortfall"]["amount"] == "1.08"
    assert cable_row["offers"][0]["estimated_cost"]["amount"] == "10.8"
    flux_row = row(result, flux)
    # No flux stock is recorded: unknown, with the declared 0.0006 kg as an upper bound.
    assert flux_row["required"]["amount"] == "0.0006" and flux_row["required"]["unit"] == "kg"
    assert flux_row["shortfall"]["status"] == "unknown"
    assert result["cost"]["status"] == "partial"
