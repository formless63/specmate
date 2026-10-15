"""History evidence never becomes a complete audit or a cached-authority read."""

import json
from uuid import UUID

import pytest
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext
from pydantic import ValidationError

from specmate.history.contracts import HistoryQuery
from specmate.history.queries import list_history
from specmate.operations import NotFound, ValidationFailed

from .conftest import ensure_member, op, remove_member
from .test_interface_conditions import rating
from .test_interfaces import create, freeze, pinout
from .test_sources import files, register


def history(user, workspace, **options):
    return list_history(user, HistoryQuery(workspace_id=workspace, **options))


def test_keyed_receipts_and_frozen_revisions_are_distinct_from_current_draft_observations(
    users, workspace
):
    owner, viewer = users["owner"], users["viewer"]
    draft = create(owner, workspace, idempotency_key="history-create")
    frozen = freeze(owner, draft, idempotency_key="history-freeze")
    rows = history(viewer, workspace)["results"]
    assert len(rows) == 3
    assert [row["evidence"] for row in rows].count("receipt") == 2
    assert [row["evidence"] for row in rows].count("revision") == 1
    assert {row["actor"]["name"] for row in rows} == {"owner"}
    exact = [row for row in rows if row["touched"][0]["basis"] == "exact_revision"]
    assert {row["touched"][0]["revision_id"] for row in exact} == {frozen["revision_id"]}
    observations = history(viewer, workspace, source="current_drafts")
    assert len(observations["results"]) == 1
    assert observations["results"][0]["evidence"] == "draft"
    assert "not historical content" in observations["hint"]
    assert observations["complete_audit"] is False
    text = json.dumps(rows)
    for forbidden in ("content", "fingerprint", "history-create", "history-freeze", "password"):
        assert forbidden not in text


def test_immutable_anchor_cursor_filters_and_record_history_do_not_fall_forward(users, workspace):
    owner = users["owner"]
    draft = create(owner, workspace, idempotency_key="one")
    frozen = freeze(owner, draft, idempotency_key="two")
    page = history(owner, workspace, limit=1)
    assert page["next_after"]
    freeze(owner, frozen["draft"], idempotency_key="later")
    rows = list(page["results"])
    while page["next_after"]:
        page = history(owner, workspace, limit=1, after=page["next_after"])
        rows.extend(page["results"])
    assert len(rows) == 3 and len({row["event_id"] for row in rows}) == 3
    assert all(row["touched"][0]["number"] != 2 for row in rows)
    own = history(owner, workspace, definition_id=draft["definition_id"], source="revisions")
    assert {row["touched"][0]["number"] for row in own["results"]} == {1, 2}
    assert history(owner, workspace, kind="cable")["results"] == []
    assert history(owner, workspace, actor_id=users["viewer"].pk)["results"] == []
    cursor = history(owner, workspace, limit=1)["next_after"]
    with pytest.raises(ValidationFailed):
        history(owner, workspace, kind="cable", after=cursor)
    with pytest.raises(ValidationFailed):
        history(users["viewer"], workspace, after=cursor)


def test_api_operation_and_current_membership_authority(users, workspace, other_workspace):
    freeze(users["owner"], create(users["owner"], workspace))
    freeze(users["outsider"], create(users["outsider"], other_workspace))
    client = Client()
    client.force_login(users["viewer"])
    response = client.get(f"/api/v0/workspace/history?workspace_id={workspace}")
    assert response.status_code == 200, response.content
    assert response["Cache-Control"] == "private, no-store"
    assert len(response.json()["results"]) == 1
    result = op(users["viewer"], "history.list", {"workspace_id": workspace})
    assert result["results"] == response.json()["results"]
    with pytest.raises(NotFound):
        history(users["viewer"], other_workspace)
    remove_member(users["viewer"], workspace=workspace)
    assert client.get(f"/api/v0/workspace/history?workspace_id={workspace}").status_code == 404


def test_registered_source_denial_withdraws_receipts_revisions_and_current_drafts_then_recovers(
    users, workspace, other_workspace
):
    owner, viewer = users["owner"], users["viewer"]
    ensure_member(owner, "admin", workspace=other_workspace)
    ensure_member(viewer, "viewer", workspace=other_workspace)
    data = b"Original synthetic history rating evidence"
    register(owner, other_workspace, data)
    source = op(
        owner,
        "source.create_original_bundle",
        {
            "workspace_id": other_workspace,
            "name": "Synthetic rating evidence",
            "files": files(data),
        },
    )
    body = freeze(owner, create(owner, workspace))
    value = pinout(body)
    declared = rating()
    declared["evidence"] = {
        "status": "registered_file",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "src/source.txt",
    }
    value["assignments"][0]["electrical"]["conditional_ratings"] = [declared]
    draft = create(owner, workspace, value, idempotency_key="protected-create")
    freeze(owner, draft, idempotency_key="protected-freeze")
    options = {"definition_id": draft["definition_id"]}
    assert len(history(viewer, workspace, **options)["results"]) == 3
    assert len(history(viewer, workspace, source="current_drafts", **options)["results"]) == 1
    remove_member(viewer, workspace=other_workspace)
    for selected in ("retained", "current_drafts"):
        page = history(viewer, workspace, source=selected, **options)
        assert page["results"] == []
        assert draft["definition_id"] not in json.dumps(page)
        assert "total" not in page
    ensure_member(viewer, "viewer", workspace=other_workspace)
    assert len(history(viewer, workspace, **options)["results"]) == 3


def test_scan_bound_advances_without_materializing_receipt_json_or_hidden_totals(
    users, workspace, monkeypatch
):
    import specmate.history.queries as module

    for _ in range(5):
        freeze(users["owner"], create(users["owner"], workspace))
    monkeypatch.setattr(module, "SCAN_LIMIT", 2)
    with CaptureQueriesContext(connection) as queries:
        page = history(users["viewer"], workspace, limit=50)
    assert len(page["results"]) == 2 and page["scan_limit_reached"]
    assert "total" not in page and "scanned" not in page
    receipt_sql = [row["sql"] for row in queries if '"operations_idempotencyrecord"' in row["sql"]]
    assert receipt_sql and all("LIMIT 2" in sql for sql in receipt_sql)
    assert all('"operations_idempotencyrecord"."result",' not in sql for sql in receipt_sql)
    ids = {row["event_id"] for row in page["results"]}
    while page["next_after"]:
        page = history(users["viewer"], workspace, limit=50, after=page["next_after"])
        ids.update(row["event_id"] for row in page["results"])
    assert len(ids) == 5


@pytest.mark.parametrize(
    "options",
    [
        {"limit": 51},
        {"actor_id": -1},
        {"kind": "bad/kind"},
        {"source": "full_audit"},
        {"from_date": "2026-01-01T00:00:00"},
    ],
)
def test_query_bounds(options):
    with pytest.raises(ValidationError):
        HistoryQuery(workspace_id=UUID(int=1), **options)
