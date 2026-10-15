"""Connector record relation pages retain exact pins and current source authority."""

from uuid import UUID

import pytest
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext

from specmate.interfaces.related import RelatedQuery, connector_relations
from specmate.operations import NotFound, ValidationFailed

from .conftest import ensure_member, op, remove_member
from .test_interface_conditions import rating
from .test_interfaces import create, freeze, pinout
from .test_sources import files, register


def relation(user, body, **options):
    return connector_relations(user, UUID(body["revision_id"]), RelatedQuery(**options))


def variant(user, scope, body):
    return freeze(user, create(user, scope, pinout(body)))


def test_body_page_has_exact_pinout_port_stack_and_older_body_flags(users, workspace):
    owner = users["owner"]
    draft = create(owner, workspace)
    older = freeze(owner, draft)
    newer = freeze(owner, older["draft"])
    pins = variant(owner, workspace, older)
    port = freeze(
        owner,
        create(
            owner,
            workspace,
            {
                "kind": "port",
                "device_label": "Synthetic device",
                "pinout_revision_id": pins["revision_id"],
            },
        ),
    )
    stack = freeze(
        owner,
        create(
            owner,
            workspace,
            {
                "kind": "end_assembly",
                "stack": {
                    "layers": [
                        {
                            "kind": "connector",
                            "layer_id": "plug",
                            "body_revision_id": older["revision_id"],
                            "pinout_revision_id": pins["revision_id"],
                        }
                    ],
                    "joins": [],
                },
            },
        ),
    )
    rows = relation(users["viewer"], newer)["results"]
    assert {row["revision_id"] for row in rows} == {
        pins["revision_id"],
        port["revision_id"],
        stack["revision_id"],
    }
    assert {row["kind"] for row in rows} == {"pinout", "port", "end_assembly"}
    assert all(row["body_revision_ids"] == [older["revision_id"]] for row in rows)
    assert all(
        row["uses_other_body_revision"] and not row["uses_selected_body_revision"] for row in rows
    )
    assert all(
        row["uses_selected_body_revision"] and not row["uses_other_body_revision"]
        for row in relation(owner, older)["results"]
    )
    assert relation(owner, newer)["compatibility"] == "not_evaluated"
    assert not any("interface" in row or "content" in row for row in rows)


def test_cursor_stays_on_frozen_anchor_uses_latest_per_definition_and_never_crosses_workspace(
    users, workspace, other_workspace
):
    owner = users["owner"]
    body = freeze(owner, create(owner, workspace))
    expected = {variant(owner, workspace, body)["revision_id"] for _ in range(4)}
    foreign = freeze(users["outsider"], create(users["outsider"], other_workspace))
    variant(users["outsider"], other_workspace, foreign)
    page = relation(users["viewer"], body, limit=1)
    first = page["results"][0]["revision_id"]
    newer = freeze(
        owner,
        op(
            owner,
            "interface.create",
            {"workspace_id": workspace, "name": "New after anchor", "interface": pinout(body)},
        ),
    )
    collected = {first}
    while page["next_after"]:
        page = relation(users["viewer"], body, limit=1, after=page["next_after"])
        collected.update(row["revision_id"] for row in page["results"])
    assert collected == expected
    assert newer["revision_id"] not in collected
    assert newer["revision_id"] in {row["revision_id"] for row in relation(owner, body)["results"]}
    with pytest.raises(NotFound):
        relation(users["viewer"], foreign)
    with pytest.raises(ValidationFailed):
        relation(owner, body, after="tampered")
    other = freeze(owner, create(owner, workspace))
    with pytest.raises(ValidationFailed):
        relation(owner, other, after=relation(owner, body, limit=1)["next_after"])


def test_latest_relation_moving_to_another_body_does_not_resurrect_old_association(
    users, workspace
):
    owner = users["owner"]
    body = freeze(owner, create(owner, workspace))
    other = freeze(owner, create(owner, workspace))
    pins = variant(owner, workspace, body)
    updated = op(
        owner,
        "interface.update",
        {"draft_id": pins["draft"]["draft_id"], "interface": pinout(other)},
        expected_state=pins["draft"]["state"],
    )
    newest = freeze(owner, updated)
    assert relation(owner, body)["results"] == []
    assert relation(owner, other)["results"][0]["revision_id"] == newest["revision_id"]


def test_readable_relation_pages_batch_dependency_queries_instead_of_per_row_reads(
    users, workspace
):
    owner = users["owner"]
    body = freeze(owner, create(owner, workspace))
    variant(owner, workspace, body)
    with CaptureQueriesContext(connection) as one:
        assert len(relation(users["viewer"], body)["results"]) == 1
    for _ in range(7):
        variant(owner, workspace, body)
    with CaptureQueriesContext(connection) as many:
        assert len(relation(users["viewer"], body)["results"]) == 8
    assert len(many) <= len(one) + 2


def test_denied_registered_source_hides_only_related_rows_across_pages_and_recovers(
    users, workspace, other_workspace
):
    owner, viewer = users["owner"], users["viewer"]
    ensure_member(owner, "admin", workspace=other_workspace)
    ensure_member(viewer, "viewer", workspace=other_workspace)
    data = b"Original synthetic connector rating source"
    register(owner, other_workspace, data)
    source = op(
        owner,
        "source.create_original_bundle",
        {"workspace_id": other_workspace, "name": "Synthetic remote rating", "files": files(data)},
    )
    body = freeze(owner, create(owner, workspace))
    clean = variant(owner, workspace, body)
    value = pinout(body)
    declared = rating()
    declared["evidence"] = {
        "status": "registered_file",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "src/source.txt",
    }
    value["assignments"][0]["electrical"]["conditional_ratings"] = [declared]
    protected = freeze(owner, create(owner, workspace, value))
    assert {row["revision_id"] for row in relation(viewer, body)["results"]} == {
        clean["revision_id"],
        protected["revision_id"],
    }
    remove_member(viewer, workspace=other_workspace)
    page = relation(viewer, body, limit=1)
    visible = list(page["results"])
    while page["next_after"]:
        page = relation(viewer, body, limit=1, after=page["next_after"])
        visible.extend(page["results"])
    assert [row["revision_id"] for row in visible] == [clean["revision_id"]]
    assert protected["revision_id"] not in str(visible)
    ensure_member(viewer, "viewer", workspace=other_workspace)
    assert {row["revision_id"] for row in relation(viewer, body)["results"]} == {
        clean["revision_id"],
        protected["revision_id"],
    }


def test_related_http_adapter_and_root_current_authority(users, workspace):
    body = freeze(users["owner"], create(users["owner"], workspace))
    variant(users["owner"], workspace, body)
    client = Client()
    client.force_login(users["viewer"])
    url = f"/api/v0/interfaces/revisions/{body['revision_id']}/related?limit=1"
    response = client.get(url)
    assert response.status_code == 200, response.content
    assert response["Cache-Control"] == "private, no-store"
    assert len(response.json()["results"]) == 1
    assert (
        len(
            op(
                users["viewer"],
                "interface.related",
                {"revision_id": body["revision_id"], "limit": 1},
            )["results"]
        )
        == 1
    )
    remove_member(users["viewer"], workspace=workspace)
    assert client.get(url).status_code == 404


def test_candidate_scan_is_bounded_and_cursor_advances_without_a_hidden_total(
    users, workspace, monkeypatch
):
    import specmate.interfaces.related as module

    monkeypatch.setattr(module, "SCAN_LIMIT", 2)
    owner = users["owner"]
    body = freeze(owner, create(owner, workspace))
    expected = {variant(owner, workspace, body)["revision_id"] for _ in range(5)}
    page = relation(owner, body, limit=50)
    assert len(page["results"]) == 2
    assert page["scan_limit_reached"] is True
    assert "total" not in page and "scanned" not in page
    collected = {row["revision_id"] for row in page["results"]}
    while page["next_after"]:
        page = relation(owner, body, limit=50, after=page["next_after"])
        assert len(page["results"]) <= 2
        collected.update(row["revision_id"] for row in page["results"])
    assert collected == expected


def test_transitive_mating_dependency_is_not_a_direct_body_relation(users, workspace):
    owner = users["owner"]
    body = freeze(owner, create(owner, workspace))
    other = freeze(
        owner,
        create(
            owner,
            workspace,
            {
                "kind": "connector_body",
                "contacts": [
                    {"contact_id": "a"},
                    {"contact_id": "b"},
                    {"contact_id": "shell", "physical_role": "shell"},
                ],
                "mates_with": [
                    {"body_revision_id": body["revision_id"], "correspondence": "same_contact_id"}
                ],
            },
        ),
    )
    pins = variant(owner, workspace, other)
    assert relation(owner, body)["results"] == []
    assert relation(owner, other)["results"][0]["revision_id"] == pins["revision_id"]


def test_body_membership_lookup_reads_only_bounded_direct_pins_not_body_history(users, workspace):
    owner = users["owner"]
    created = create(owner, workspace)
    body = freeze(owner, created)
    selected = body
    for _ in range(8):
        selected = freeze(owner, selected["draft"])
    pins = variant(owner, workspace, body)
    with CaptureQueriesContext(connection) as queries:
        page = relation(users["viewer"], selected)
    assert page["results"][0]["revision_id"] == pins["revision_id"]
    membership_reads = [
        row["sql"]
        for row in queries
        if row["sql"].startswith('SELECT "design_revision"."id" AS "id"')
        and created["definition_id"].replace("-", "") in row["sql"].replace("-", "")
    ]
    assert len(membership_reads) == 1
    assert '"design_revision"."id" IN (' in membership_reads[0]
    assert body["revision_id"].replace("-", "") in membership_reads[0].replace("-", "")
    assert selected["revision_id"].replace("-", "") not in membership_reads[0].replace("-", "")
