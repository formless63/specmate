"""AGT-003: maker preferences are defaults for forms and agents, never engineering facts."""

import uuid

import pytest
from django.test import Client

from specmate.facts.models import FactAssertion
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    execute,
)

from .conftest import op


def call(user, payload, expected="preferences-v0"):
    ctx = Context(
        user=user, via="api", request_id=f"pref-{uuid.uuid4().hex[:8]}", expected_state=expected
    )
    return execute("preferences.set", ctx, payload).result


def discover(user, workspace):
    return op(user, "discovery.capabilities", {"workspace_id": workspace})


def test_workspace_defaults_and_user_override_merge_with_sources(users, workspace):
    result = call(
        users["owner"],
        {
            "workspace_id": workspace,
            "scope": "workspace",
            "values": {
                "preferred_suppliers": ["Acme Parts"],
                "wire_colours": ["red", "black"],
                "default_length_unit": "mm",
            },
        },
    )
    assert result["workspace"]["state_token"] == "preferences-v1"
    own = call(
        users["editor"],
        {"workspace_id": workspace, "scope": "user", "values": {"default_length_unit": "in"}},
    )
    eff = own["effective"]
    assert eff["default_length_unit"] == {"value": "in", "source": "user"}
    assert eff["preferred_suppliers"] == {"value": ["Acme Parts"], "source": "workspace"}
    assert eff["connector_families"] == {"value": None, "source": "none"}
    # Another member sees the workspace default, not the editor's override.
    other = discover(users["viewer"], workspace)["preferences"]["effective"]
    assert other["default_length_unit"] == {"value": "mm", "source": "workspace"}


def test_explicit_null_clears_and_partial_update_keeps_others(users, workspace):
    call(
        users["owner"],
        {
            "workspace_id": workspace,
            "scope": "workspace",
            "values": {"wire_colours": ["red"], "connector_families": ["Example family"]},
        },
    )
    after = call(
        users["owner"],
        {"workspace_id": workspace, "scope": "workspace", "values": {"wire_colours": None}},
        expected="preferences-v1",
    )
    assert after["workspace"]["values"] == {"connector_families": ["Example family"]}
    assert after["effective"]["wire_colours"]["source"] == "none"


def test_authority_scope_and_state(users, workspace, other_workspace):
    body = {"workspace_id": workspace, "scope": "workspace", "values": {"wire_colours": ["red"]}}
    with pytest.raises(PermissionDenied):
        call(users["contributor"], body)
    call(users["editor"], body)
    # Even a viewer may keep a personal override.
    call(users["viewer"], {**body, "scope": "user"})
    with pytest.raises(NotFound):
        call(users["outsider"], body)
    with pytest.raises(NotFound):
        discover(users["outsider"], workspace)
    with pytest.raises(Conflict) as stale:
        call(users["owner"], body)
    assert stale.value.details["current_state"] == "preferences-v1"
    with pytest.raises(ValidationFailed):
        call(
            users["owner"],
            {"workspace_id": workspace, "scope": "workspace", "values": {}},
            expected="preferences-v1",
        )


@pytest.mark.parametrize(
    "values",
    [
        {"connector_families": [{"name": "Example family", "rating": 5}]},
        {"connector_rating_amps": 5},
        {"wire_colours": ["red", "RED"]},
        {"default_length_unit": "furlong"},
    ],
)
def test_preferences_cannot_carry_ratings_or_invalid_values(users, workspace, values):
    with pytest.raises(ValidationFailed):
        call(users["owner"], {"workspace_id": workspace, "scope": "workspace", "values": values})


def test_preference_is_labelled_and_creates_no_fact(users, workspace):
    before = FactAssertion.objects.count()
    call(
        users["owner"],
        {
            "workspace_id": workspace,
            "scope": "workspace",
            "values": {"connector_families": ["Familiar family"]},
        },
    )
    prefs = discover(users["owner"], workspace)["preferences"]
    assert prefs["kind"] == "preference"
    assert prefs["engineering_fact"] is False
    assert "not ratings" in prefs["note"]
    # A preferred connector family gains no rating, and nothing becomes a recorded fact.
    assert set(prefs["effective"]["connector_families"]) == {"value", "source"}
    assert FactAssertion.objects.count() == before


def test_discovery_without_scope_has_no_preferences(users):
    ctx = Context(user=users["owner"], via="api", request_id="pref-noscope")
    assert execute("discovery.capabilities", ctx, {}).result["preferences"] is None


def test_http_read_and_operation_endpoint_share_the_operation(users, workspace):
    client = Client()
    client.force_login(users["owner"])
    envelope = {
        "operation": "preferences.set",
        "request_id": "pref-http-1",
        "expected_state": "preferences-v0",
        "payload": {
            "workspace_id": workspace,
            "scope": "workspace",
            "values": {"preferred_suppliers": ["Acme Parts"]},
        },
    }
    posted = client.post("/api/v0/operations", envelope, content_type="application/json")
    assert posted.status_code == 200, posted.content
    read = client.get(f"/api/v0/preferences?workspace_id={workspace}")
    assert read.status_code == 200
    assert read.json()["effective"]["preferred_suppliers"]["value"] == ["Acme Parts"]
    assert read.headers["Cache-Control"] == "private, no-store"
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/preferences?workspace_id={workspace}").status_code == 404
