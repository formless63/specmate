"""Compact Library rows: exact state, global filtering and bounded queries."""

import json
import uuid

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from specmate.catalog.models import ManufacturerVariant
from specmate.design.models import Revision, Snapshot
from specmate.operations import NotFound
from specmate.workspace import table
from specmate.workspace.table_contracts import ListLibraryTable

from .test_project_references import add
from .test_transports import api
from .test_workspace_designs import design


def page(user, **params):
    return table.list_library_table(user, ListLibraryTable(**params))


def variant(owner, revision, value="SP-100"):
    ManufacturerVariant.objects.create(
        revision=revision,
        manufacturer="Synthetic maker",
        part_number=value,
        association_basis="Synthetic association",
        registered_by=owner,
    )


def test_exact_frozen_body_and_mpn_win_over_later_draft(users, workspace):
    owner = users["owner"]
    _, draft, revision = design(
        owner,
        workspace,
        "Synthetic plug",
        "connector_body",
        {"interface": {"family": "Round", "mating_role": "plug", "contacts": [{"id": "1"}]}},
        True,
    )
    variant(owner, revision)
    draft.content = {"interface": {"family": "Changed", "contacts": []}}
    draft.save()
    row = page(users["viewer"])["results"][0]
    summary = row["summary"]
    assert row["latest_revision_id"] == summary["revision_id"] == str(revision.id)
    assert summary["basis"] == "latest_frozen" and summary["draft_id"] is None
    assert summary["numbers"] == [
        {"manufacturer": "Synthetic maker", "value": "SP-100", "basis": "manufacturer_variant"}
    ]
    assert {f["key"]: f["value"] for f in summary["fields"]} == {
        "family": "Round",
        "role": "plug",
        "pins": 1,
        "variants": None,
        "ports": None,
    }


def test_search_mpn_kind_project_before_pagination(users, workspace, project):
    owner = users["owner"]
    old, draft, revision = design(owner, workspace, "Old part", "part", freeze=True)
    variant(owner, revision, "100%_X")
    for i in range(4):
        design(owner, workspace, f"Newer {i}", "board")
    add(owner, project, "revision", str(revision.id))
    result = page(
        users["viewer"],
        query="100%_",
        kinds=["part"],
        project_id=project,
        referenced_only=True,
        limit=1,
    )
    assert [r["record_id"] for r in result["results"]] == [str(old.id)]
    assert result["next_after"] is None
    assert page(users["viewer"], query="100%Z")["results"] == []
    snapshot = Snapshot.objects.create(
        definition=old,
        draft=draft,
        draft_version=1,
        canonical=json.dumps({"content": {}}).encode(),
        sha256="1" * 64,
        created_by=owner,
    )
    Revision.objects.create(definition=old, snapshot=snapshot, number=2, frozen_by=owner)
    assert page(users["viewer"], query="100%_")["results"] == []


def test_saved_draft_unknowns_and_drain_not_counted_as_core(users, workspace):
    _, draft, _ = design(
        users["owner"],
        workspace,
        "Synthetic stock",
        "wire_stock",
        {
            "stock": {
                "construction": "pair",
                "structure": {
                    "kind": "group",
                    "children": [
                        {"kind": "conductor"},
                        {"kind": "conductor"},
                        {"kind": "drain"},
                        {"kind": "jacket", "outer_diameter_mm": None},
                    ],
                },
                "facts": {"impedance": {"status": "unknown", "value": None}},
            }
        },
    )
    summary = page(users["viewer"])["results"][0]["summary"]
    assert summary["basis"] == "newest_draft"
    assert summary["draft_id"] == str(draft.id) and summary["draft_version"] == 1
    assert summary["revision_id"] is None and summary["numbers"] == []
    assert {f["key"]: f["value"] for f in summary["fields"]} == {
        "construction": "pair",
        "cores": 2,
        "outer_diameter": None,
        "impedance": None,
    }
    assert "pass" not in str(summary).lower()


def test_read_authority_and_constant_query_count(users, workspace, other_workspace):
    owner = users["owner"]
    design(owner, workspace, "Own", "part")
    design(users["outsider"], other_workspace, "Hidden", "part")
    with CaptureQueriesContext(connection) as one:
        page(users["viewer"])
    for i in range(15):
        design(owner, workspace, f"Own {i}", "part")
    with CaptureQueriesContext(connection) as many:
        result = page(users["viewer"])
    assert len(many) == len(one)
    assert len(result["results"]) == 16
    assert "Hidden" not in str(result) and "canonical" not in str(result)
    assert api().get("/api/v0/workspace/library-table").status_code == 401
    assert api(users["viewer"]).get("/api/v0/workspace/library-table").status_code == 200
    with pytest.raises(NotFound) as hidden:
        page(users["outsider"], workspace_id=workspace)
    with pytest.raises(NotFound) as missing:
        page(users["outsider"], workspace_id=uuid.uuid4())
    assert str(hidden.value) == str(missing.value)


def test_competing_freeze_does_not_mix_revision_and_summary(users, workspace, monkeypatch):
    owner = users["owner"]
    definition, draft, revision = design(
        owner, workspace, "Changing body", "connector_body", {"interface": {"family": "Old"}}, True
    )
    original_records = table._records

    def freeze_before_records(*args):
        snapshot = Snapshot.objects.create(
            definition=definition,
            draft=draft,
            draft_version=1,
            canonical=json.dumps({"content": {"interface": {"family": "New"}}}).encode(),
            sha256="2" * 64,
            created_by=owner,
        )
        Revision.objects.create(definition=definition, snapshot=snapshot, number=2, frozen_by=owner)
        return original_records(*args)

    monkeypatch.setattr(table, "_records", freeze_before_records)
    row = page(users["viewer"])["results"][0]
    assert row["latest_revision"] == 1
    assert row["latest_revision_id"] == row["summary"]["revision_id"] == str(revision.id)
    assert row["summary"]["fields"][0]["value"] == "Old"


def test_port_summary_counts_facts_not_connector_contacts(users, workspace):
    design(
        users["owner"],
        workspace,
        "Sparse port",
        "port",
        {
            "interface": {
                "device_label": "Synthetic instrument",
                "role": "source",
                "pins": [{"contact_id": "one"}],
            }
        },
    )
    fields = page(users["viewer"])["results"][0]["summary"]["fields"]
    pins = next(field for field in fields if field["key"] == "pins")
    assert pins["label"] == "Pin facts" and pins["value"] == 1


def test_pages_cover_all_filtered_rows_without_duplicates(users, workspace):
    for index in range(5):
        design(users["owner"], workspace, f"Synthetic part {index}", "part")
        design(users["owner"], workspace, f"Synthetic board {index}", "board")
    seen, after = [], None
    while True:
        result = page(users["viewer"], kinds=["part"], query="Synthetic", limit=2, after=after)
        seen.extend(row["record_id"] for row in result["results"])
        after = result["next_after"]
        if after is None:
            break
    assert len(seen) == len(set(seen)) == 5


def test_associations_are_bounded_but_search_matches_unshown_numbers(users, workspace):
    owner = users["owner"]
    _, _, revision = design(owner, workspace, "Many variants", "part", freeze=True)
    for index in range(22):
        variant(owner, revision, f"SP-{index:03}")
    summary = page(users["viewer"], query="SP-021")["results"][0]["summary"]
    assert len(summary["numbers"]) == 20 and summary["numbers_truncated"]
    assert summary["numbers"][0]["value"] == "SP-000"
