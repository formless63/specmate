"""EXT-004: optional integrations via declared field ownership; observations, not facts."""

import csv
import io
import json
from datetime import date, timedelta

import pytest
from django.db import DatabaseError, transaction

from specmate.integrations.models import ExternalObservation
from specmate.inventory.models import StockEntry
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.sourcing.models import SupplierOffer
from specmate.sourcing.queries import report

from .conftest import op, set_grants
from .scope_helpers import workspace_of
from .test_sourcing import make_sourced, row, stock

DAY = (date.today() - timedelta(days=1)).isoformat()


@pytest.fixture
def sourced(users, project):
    return make_sourced(users, project)


def make(users, sourced, ownership=None, who="owner", **extra):
    return op(
        users[who],
        "integration.create",
        {
            "workspace_id": workspace_of(sourced["project"]),
            "name": "Synthetic ERP",
            "ownership": ownership
            or {"supplier_offer": "external", "stock_observation": "external", "needs": "specmate"},
            **extra,
        },
    )


def csv_of(rows, header):
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return out.getvalue()


def do_import(users, integ, field, content, who="owner", fmt="csv"):
    return op(
        users[who],
        "integration.import",
        {
            "integration_id": integ["integration_id"],
            "field": field,
            "file_name": "synthetic." + fmt,
            "file_format": fmt,
            "content": content,
        },
    )


OFFER_HEADER = ["revision_id", "supplier", "offered_on", "price_amount", "price_currency"]


def test_ownership_is_a_closed_declared_vocabulary_set_by_admins(users, sourced):
    with pytest.raises((PermissionDenied, NotFound)):
        make(users, sourced, who="editor")
    for bad in (
        {"supplier_offer": "specmate"},
        {"needs": "external"},
        {"design_revision": "external"},
    ):
        with pytest.raises(ValidationFailed):
            make(users, sourced, ownership=bad)
    integ = make(users, sourced, columns={"supplier": "Vendor"})
    assert integ["ownership"]["supplier_offer"] == "external" and integ["enabled"]
    with pytest.raises(Conflict):
        make(users, sourced)
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "integration.create",
            {
                "workspace_id": workspace_of(sourced["project"]),
                "name": "Bad columns",
                "ownership": {"needs": "specmate"},
                "columns": {"nope": "x"},
            },
        )


def test_update_requires_current_state_and_disable_stops_use(users, sourced):
    integ = make(users, sourced)
    body = {"integration_id": integ["integration_id"], "ownership": {"needs": "specmate"}}
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "integration.update",
            body,
            expected_state="00000000-0000-0000-0000-000000000000",
        )
    updated = op(
        users["owner"],
        "integration.update",
        {**body, "enabled": False},
        expected_state=integ["state"],
    )
    assert updated["state"] != integ["state"] and not updated["enabled"]
    with pytest.raises(Conflict):
        do_import(users, updated, "supplier_offer", csv_of([], OFFER_HEADER))


def test_import_records_attributed_offer_observations_without_touching_facts(users, sourced):
    stock(users, sourced, sourced["board"], "3")
    entries = StockEntry.objects.count()
    integ = make(users, sourced, columns={"supplier": "Vendor"})
    board = sourced["board"]["revision_id"]
    content = csv_of(
        [
            [board, "Synthetic Supply", DAY, "12.50", "USD"],
            [board, "Other Supply", DAY, "", ""],  # unknown price stays unknown
        ],
        ["revision_id", "Vendor", "offered_on", "price_amount", "price_currency"],
    )
    result = do_import(users, integ, "supplier_offer", content)
    assert result["accepted_count"] == 2 and result["rejected_count"] == 0
    assert result["ledger_written"] is False and result["actor"]["username"] == "owner"
    again = do_import(users, integ, "supplier_offer", content)
    assert again["duplicate_of_earlier_run"] and again["run_id"] == result["run_id"]
    assert ExternalObservation.objects.count() == 2
    listed = op_get(users, sourced, board)
    unpriced = next(o for o in listed["observations"] if o["supplier"] == "Other Supply")
    assert unpriced["price"] is None
    priced = next(o for o in listed["observations"] if o["supplier"] == "Synthetic Supply")
    assert priced["price"]["amount"] == "12.5"
    assert priced["attribution"]["file_sha256"] == result["file_sha256"]
    assert listed["is_stock_ledger"] is False
    # Reviewed offers, the stock ledger and the sourcing report are untouched.
    assert SupplierOffer.objects.count() == 0 and StockEntry.objects.count() == entries
    sourcing = report(users["owner"], sourced["bom"]["revision_id"])
    assert row(sourcing, sourced["board"])["offer_status"] == "none_on_record"
    assert row(sourcing, sourced["board"])["stock"]["available"]["amount"] == "3"


def op_get(users, sourced, revision_id):
    from specmate.integrations.queries import list_observations

    return list_observations(users["viewer"], workspace_of(sourced["project"]), revision_id)


def test_bad_rows_are_rejected_with_reasons_and_good_rows_kept(users, sourced, other_workspace):
    integ = make(users, sourced)
    board = sourced["board"]["revision_id"]
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    content = csv_of(
        [
            [board, "Ok", DAY, "1", "USD"],
            ["not-a-uuid", "X", DAY, "1", "USD"],
            [board, "Future", tomorrow, "1", "USD"],
            [board, "Neg", DAY, "-1", "USD"],
            [board, "BadCur", DAY, "1", "usd"],
            [board, "", DAY, "1", "USD"],
        ],
        OFFER_HEADER,
    )
    result = do_import(users, integ, "supplier_offer", content)
    assert result["accepted_count"] == 1 and result["rejected_count"] == 5
    assert [r["row"] for r in result["rejections"]] == [2, 3, 4, 5, 6]
    with pytest.raises(ValidationFailed):
        do_import(users, integ, "supplier_offer", "{", fmt="json")


def test_stock_observations_need_inventory_authority_and_are_not_ledger_entries(users, sourced):
    integ = make(users, sourced)
    board = sourced["board"]["revision_id"]
    content = json.dumps(
        {
            "rows": [
                {
                    "revision_id": board,
                    "observed_on": DAY,
                    "quantity_amount": "7",
                    "quantity_unit": "ea",
                    "location_label": "ERP warehouse",
                },
                {
                    "revision_id": board,
                    "observed_on": DAY,
                    "quantity_amount": None,
                    "quantity_unit": "ea",
                },
            ]
        }
    )
    with pytest.raises(PermissionDenied):
        do_import(users, integ, "stock_observation", content, who="contributor", fmt="json")
    before = StockEntry.objects.count()
    result = do_import(users, integ, "stock_observation", content, fmt="json")
    assert result["accepted_count"] == 1 and result["rejected_count"] == 1
    assert StockEntry.objects.count() == before
    sourcing = report(users["owner"], sourced["bom"]["revision_id"])
    assert row(sourcing, sourced["board"])["stock"]["status"] == "none_recorded"
    set_grants(users["contributor"], ["inventory.manage"], project=sourced["project"])
    second = content.replace('"7"', '"8"')
    assert (
        do_import(users, integ, "stock_observation", second, who="contributor", fmt="json")[
            "accepted_count"
        ]
        == 1
    )


def test_field_not_declared_external_is_refused(users, sourced):
    integ = make(users, sourced, ownership={"needs": "specmate"})
    with pytest.raises(ValidationFailed):
        do_import(users, integ, "supplier_offer", csv_of([], OFFER_HEADER))


def test_viewer_cannot_import_or_export_and_outsider_sees_nothing(users, sourced):
    integ = make(users, sourced)
    with pytest.raises(PermissionDenied):
        do_import(users, integ, "supplier_offer", csv_of([], OFFER_HEADER), who="viewer")
    with pytest.raises((PermissionDenied, NotFound)):
        do_import(users, integ, "supplier_offer", csv_of([], OFFER_HEADER), who="outsider")
    from specmate.integrations.queries import list_integrations

    with pytest.raises((PermissionDenied, NotFound)):
        list_integrations(users["outsider"], workspace_of(sourced["project"]))


def test_export_needs_is_explicit_recorded_and_exact(users, sourced):
    integ = make(users, sourced, columns={"required_amount": "qty"})
    payload = {
        "integration_id": integ["integration_id"],
        "revision_id": sourced["bom"]["revision_id"],
    }
    with pytest.raises(PermissionDenied):
        op(users["contributor"], "integration.export_needs", payload)
    result = op(users["owner"], "integration.export_needs", payload)
    rows = list(csv.DictReader(io.StringIO(result["content"])))
    assert {r["revision_id"] for r in rows} == {
        sourced["board"]["revision_id"],
        sourced["component"]["revision_id"],
    }
    assert all(r["qty"] == "1" and r["unit"] == "ea" for r in rows)
    assert result["row_count"] == 2 and result["actor"]["username"] == "owner"
    from specmate.integrations.models import ExportRecord
    from specmate.integrations.queries import sha256

    record = ExportRecord.objects.get()
    assert record.content == result["content"] and record.content_sha256 == sha256(record.content)
    with pytest.raises(DatabaseError), transaction.atomic():
        ExportRecord.objects.filter(id=record.id).update(row_count=9)
    as_json = op(users["owner"], "integration.export_needs", {**payload, "file_format": "json"})
    assert len(json.loads(as_json["content"])["rows"]) == 2
    assert ExportRecord.objects.count() == 2


def test_export_requires_declared_ownership_and_plan_revision(users, sourced):
    integ = make(users, sourced, ownership={"supplier_offer": "external"})
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "integration.export_needs",
            {
                "integration_id": integ["integration_id"],
                "revision_id": sourced["bom"]["revision_id"],
            },
        )


def test_observations_are_immutable(users, sourced):
    integ = make(users, sourced)
    content = csv_of([[sourced["board"]["revision_id"], "S", DAY, "1", "USD"]], OFFER_HEADER)
    do_import(users, integ, "supplier_offer", content)
    observation = ExternalObservation.objects.get()
    with pytest.raises(DatabaseError), transaction.atomic():
        ExternalObservation.objects.filter(id=observation.id).update(supplier="Changed")
    with pytest.raises(DatabaseError), transaction.atomic():
        observation.delete()


def test_no_integration_leaves_engineering_work_functional(users, sourced):
    # No integration exists: the sourcing report and BOM read work and nothing is created.
    result = report(users["owner"], sourced["bom"]["revision_id"])
    assert row(result, sourced["board"])["stock"]["status"] == "none_recorded"
    assert ExternalObservation.objects.count() == 0
