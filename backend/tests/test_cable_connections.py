"""Frozen connection discovery keeps intent pins exact and current authority fresh."""

import copy
import json

import pytest
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext

from specmate.cables.connections import ConnectionsQuery, connections
from specmate.cables.contracts import Cable
from specmate.design.models import Snapshot
from specmate.operations import NotFound, ValidationFailed

from .conftest import ensure_member, op, remove_member
from .test_cables import capture, create, fixture
from .test_interface_conditions import rating
from .test_interfaces import create as interface_create
from .test_interfaces import freeze, pinout
from .test_sources import files, register


@pytest.fixture
def pair(users, workspace):
    owner = users["owner"]
    _, _, stock, body, pins, cable = fixture(owner, workspace)
    ports = [
        freeze(
            owner,
            interface_create(
                owner,
                workspace,
                {"kind": "port", "device_label": side, "pinout_revision_id": pins["revision_id"]},
            ),
        )
        for side in ("From device", "To device")
    ]
    intent = freeze(
        owner,
        interface_create(
            owner,
            workspace,
            {
                "kind": "cable_intent",
                "from_revision_id": ports[0]["revision_id"],
                "to_revision_id": ports[1]["revision_id"],
            },
        ),
    )
    cable = Cable.model_validate(cable).model_dump(mode="json")
    cable["intent_revision_id"] = intent["revision_id"]
    frozen = capture(owner, create(owner, workspace, cable))
    return {
        "ports": ports,
        "intent": intent,
        "cable": cable,
        "frozen": frozen,
        "body": body,
        "pins": pins,
        "stock": stock,
    }


def read(user, pair, **kwargs):
    return connections(
        user,
        ConnectionsQuery(
            from_revision_id=pair["ports"][0]["revision_id"],
            to_revision_id=pair["ports"][1]["revision_id"],
            **kwargs,
        ),
    )


def test_exact_reverse_and_older_port_pins_are_explicit_without_compatibility(users, pair):
    viewer = users["viewer"]
    row = read(viewer, pair)["results"][0]
    assert row["revision_id"] == pair["frozen"]["revision_id"]
    assert row["intent_revision_id"] == pair["intent"]["revision_id"]
    assert row["uses_selected_port_revisions"] and not row["uses_other_port_revisions"]
    assert row["orientation"] == "from_to"
    reverse = {**pair, "ports": pair["ports"][::-1]}
    assert read(viewer, reverse)["results"][0]["orientation"] == "to_from"
    newer = freeze(users["owner"], pair["ports"][0]["draft"])
    advanced = {**pair, "ports": [newer, pair["ports"][1]]}
    page = read(viewer, advanced)
    assert page["label"] == "Frozen designs connecting these ports"
    assert page["results"][0]["uses_other_port_revisions"]
    assert not page["results"][0]["uses_selected_port_revisions"]
    assert page["results"][0]["from_revision_id"] == pair["ports"][0]["revision_id"]
    assert page["compatibility"] == "not_evaluated"


def test_paging_anchor_latest_cable_intent_is_not_replaced_and_cursors_bind_actor_pair(
    users, workspace, pair
):
    owner = users["owner"]
    other = capture(owner, create(owner, workspace, pair["cable"]))
    first = read(owner, pair, limit=1)
    assert first["next_after"]
    capture(owner, pair["frozen"]["draft"])
    later_intent = freeze(owner, pair["intent"]["draft"])
    rest = read(owner, pair, limit=1, after=first["next_after"])
    ids = {row["revision_id"] for row in first["results"] + rest["results"]}
    assert ids == {pair["frozen"]["revision_id"], other["revision_id"]}
    assert all(
        row["intent_revision_id"] != later_intent["revision_id"]
        for row in first["results"] + rest["results"]
    )
    with pytest.raises(ValidationFailed):
        read(users["viewer"], pair, after=first["next_after"])
    with pytest.raises(ValidationFailed):
        read(owner, {**pair, "ports": pair["ports"][::-1]}, after=first["next_after"])


def test_missing_intent_drafts_and_other_port_pair_are_not_claimed_as_connections(
    users, workspace, pair
):
    owner = users["owner"]
    value = copy.deepcopy(pair["cable"])
    value.pop("intent_revision_id")
    capture(owner, create(owner, workspace, value))
    create(owner, workspace, pair["cable"])
    assert len(read(users["viewer"], pair)["results"]) == 1
    other = freeze(
        owner,
        interface_create(
            owner,
            workspace,
            {
                "kind": "port",
                "device_label": "Third device",
                "pinout_revision_id": pair["pins"]["revision_id"],
            },
        ),
    )
    assert read(owner, {**pair, "ports": [pair["ports"][0], other]})["results"] == []
    with pytest.raises(ValidationFailed):
        read(owner, {**pair, "ports": [pair["pins"], pair["ports"][1]]})


def test_current_membership_other_workspace_api_and_shared_operation(
    users, workspace, other_workspace, pair
):
    viewer, outsider = users["viewer"], users["outsider"]
    query = {
        "from_revision_id": pair["ports"][0]["revision_id"],
        "to_revision_id": pair["ports"][1]["revision_id"],
    }
    client = Client()
    client.force_login(viewer)
    response = client.get("/api/v0/cables/connections", query)
    assert response.status_code == 200, response.content
    assert response["Cache-Control"] == "private, no-store"
    assert op(viewer, "cable.connections", query)["results"] == response.json()["results"]
    assert client.get("/api/v0/cables/connections", {**query, "limit": 51}).status_code == 422
    foreign_body = freeze(outsider, interface_create(outsider, other_workspace))
    with pytest.raises(NotFound):
        connections(
            viewer, ConnectionsQuery(**{**query, "to_revision_id": foreign_body["revision_id"]})
        )
    remove_member(viewer, workspace=workspace)
    assert client.get("/api/v0/cables/connections", query).status_code == 404


def test_source_closure_denial_hides_candidate_metadata_and_rechecks_cursor_then_recovers(
    users, workspace, other_workspace, pair
):
    owner, viewer = users["owner"], users["viewer"]
    ensure_member(owner, "admin", workspace=other_workspace)
    ensure_member(viewer, "viewer", workspace=other_workspace)
    data = b"Synthetic connection source evidence"
    register(owner, other_workspace, data)
    source = op(
        owner,
        "source.create_original_bundle",
        {"workspace_id": other_workspace, "name": "Connection evidence", "files": files(data)},
    )
    value = pinout(pair["body"])
    declared = rating()
    declared["evidence"] = {
        "status": "registered_file",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "src/source.txt",
    }
    value["assignments"][0]["electrical"]["conditional_ratings"] = [declared]
    protected = freeze(owner, interface_create(owner, workspace, value))
    cable = copy.deepcopy(pair["cable"])
    cable["endpoints"][0]["stack"]["layers"][0]["pinout_revision_id"] = protected["revision_id"]
    hidden = capture(owner, create(owner, workspace, cable))
    before = bytes(Snapshot.objects.get(id=hidden["snapshot_id"]).canonical)
    assert len(read(viewer, pair)["results"]) == 2
    cursor = read(viewer, pair, limit=1)["next_after"]
    remove_member(viewer, workspace=other_workspace)
    result = read(viewer, pair)
    assert [row["revision_id"] for row in result["results"]] == [pair["frozen"]["revision_id"]]
    assert hidden["revision_id"] not in json.dumps(read(viewer, pair, after=cursor))
    assert "total" not in result
    ensure_member(viewer, "viewer", workspace=other_workspace)
    assert len(read(viewer, pair)["results"]) == 2
    assert bytes(Snapshot.objects.get(id=hidden["snapshot_id"]).canonical) == before


def test_candidate_scan_is_bounded_without_counts_or_unbounded_json_reads(
    users, workspace, pair, monkeypatch
):
    import specmate.cables.connections as module

    monkeypatch.setattr(module, "SCAN_LIMIT", 2)
    for _ in range(2):
        capture(users["owner"], create(users["owner"], workspace, pair["cable"]))
    with CaptureQueriesContext(connection) as queries:
        first = read(users["viewer"], pair)
    assert len(first["results"]) == 2 and first["scan_limit_reached"] and first["next_after"]
    candidate = [
        query["sql"]
        for query in queries
        if 'AS "definition__name"' in query["sql"] and "EXISTS(" in query["sql"]
    ]
    assert len(candidate) == 1 and "LIMIT 3" in candidate[0]
    assert '"canonical"' not in candidate[0] and "COUNT(" not in candidate[0]
    rest = read(users["viewer"], pair, after=first["next_after"])
    assert len(rest["results"]) == 1 and not rest["next_after"]
    assert not (
        {row["revision_id"] for row in first["results"]}
        & {row["revision_id"] for row in rest["results"]}
    )
