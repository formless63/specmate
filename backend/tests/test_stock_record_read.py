"""Bounded single-definition draft selection for the drawing-first stock record."""

import uuid

import pytest
from django.utils import timezone

from specmate.design.models import Definition, Draft
from specmate.operations import NotFound, ValidationFailed
from specmate.wire_stock.queries import list_stocks

from .test_transports import api
from .test_wire_stock import create, fixture


def test_definition_filter_selects_newest_draft_and_leaves_default_list_unchanged(users, workspace):
    first = create(users, workspace)
    other = create(users, workspace)
    definition = Definition.objects.get(id=first["definition_id"])
    newer = Draft.objects.create(
        definition=definition,
        content={"stock": fixture("pair")},
        version=3,
        updated_by=users["owner"],
    )
    rows = list_stocks(users["viewer"], definition_id=definition.id, latest_only=True)
    assert len(rows) == 1 and rows[0]["draft_id"] == str(newer.id)
    assert rows[0]["state"] == "draft-v3"
    assert rows[0]["content"]["stock"]["construction"] == "pair"
    assert len(list_stocks(users["viewer"])) == 3
    assert len(list_stocks(users["viewer"], definition_id=other["definition_id"])) == 1
    # Equal timestamps have a stable UUID tie-breaker.
    Draft.objects.filter(definition=definition).update(updated_at=timezone.now())
    expected = str(Draft.objects.filter(definition=definition).order_by("-id").first().id)
    assert (
        list_stocks(users["viewer"], definition_id=definition.id, latest_only=True)[0]["draft_id"]
        == expected
    )


def test_scope_precedes_filter_and_unrelated_kinds_are_absent(users, workspace, other_workspace):
    stock = create(users, workspace)
    assert (
        list_stocks(users["outsider"], definition_id=stock["definition_id"], latest_only=True) == []
    )
    with pytest.raises(NotFound):
        list_stocks(
            users["outsider"],
            workspace_id=workspace,
            definition_id=stock["definition_id"],
            latest_only=True,
        )
    unrelated = Definition.objects.create(
        workspace_id=workspace, kind="part", name="Synthetic part", created_by=users["owner"]
    )
    Draft.objects.create(definition=unrelated, content={}, updated_by=users["owner"])
    assert list_stocks(users["viewer"], definition_id=unrelated.id, latest_only=True) == []
    assert list_stocks(users["viewer"], definition_id=uuid.uuid4(), latest_only=True) == []
    with pytest.raises(ValidationFailed):
        list_stocks(users["viewer"], latest_only=True)
    assert (
        api()
        .get("/api/v0/stocks?latest_only=true&definition_id=" + stock["definition_id"])
        .status_code
        == 401
    )
    response = api(users["viewer"]).get(
        "/api/v0/stocks?latest_only=true&definition_id=" + stock["definition_id"]
    )
    assert response.status_code == 200 and len(response.json()) == 1
