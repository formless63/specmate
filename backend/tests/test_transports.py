"""ACC-FND-006/007 groundwork: every transport uses the same operation rules."""

import pytest
from django.test import Client

from specmate.operations import PermissionDenied

from .conftest import op


def api(user=None):
    client = Client()
    if user is not None:
        client.force_login(user)
    return client


def post_op(client, operation, payload, **envelope):
    body = {"operation": operation, "request_id": "r-api", "payload": payload, **envelope}
    return client.post("/api/v0/operations", body, content_type="application/json")


def test_same_unauthorized_mutation_rejected_by_api_and_jobs(users, definition):
    payload = {"draft_id": definition["draft_id"], "changes": {"a": 9}}
    response = post_op(api(users["viewer"]), "draft.update", payload, expected_state="draft-v1")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "permission_denied"
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "draft.update", payload, expected_state="draft-v1")


def test_api_requires_authentication(definition):
    response = post_op(api(), "draft.update", {"draft_id": definition["draft_id"]})
    assert response.status_code == 401


def test_api_mutation_and_stale_conflict(users, definition):
    client = api(users["editor"])
    payload = {"draft_id": definition["draft_id"], "changes": {"a": 2}}
    ok = post_op(client, "draft.update", payload, expected_state="draft-v1")
    assert ok.status_code == 200 and ok.json()["result"]["state"] == "draft-v2"
    stale = post_op(client, "draft.update", payload, expected_state="draft-v1")
    assert stale.status_code == 409
    assert stale.json()["error"]["details"]["current"]["state"] == "draft-v2"


def test_unknown_and_dedicated_operations_are_not_generic(users):
    client = api(users["owner"])
    assert post_op(client, "nothing.here", {}).status_code == 404
    assert post_op(client, "installation.claim_owner", {}).status_code == 404
    assert post_op(client, "source.register_blob", {}).status_code == 404


def test_uninvited_user_cannot_enumerate_projects_or_contents(users, project, definition):
    outsider = api(users["outsider"])
    assert outsider.get("/api/v0/projects").json() == []
    missing = outsider.get(f"/api/v0/projects/{project}/definitions")
    nonexistent = outsider.get("/api/v0/projects/00000000-0000-0000-0000-000000000000/definitions")
    assert missing.status_code == nonexistent.status_code == 404
    assert missing.json() == nonexistent.json()
    assert outsider.get(f"/api/v0/drafts/{definition['draft_id']}").status_code == 404
    member = api(users["viewer"])
    assert [p["project_id"] for p in member.get("/api/v0/projects").json()] == [project]


def test_revision_snapshot_bytes_are_served_exactly(users, definition):
    frozen = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": definition["draft_id"]},
        expected_state="draft-v1",
    )
    client = api(users["viewer"])
    raw = client.get(f"/api/v0/revisions/{frozen['revision_id']}/snapshot")
    assert raw.status_code == 200
    import hashlib

    assert hashlib.sha256(raw.content).hexdigest() == frozen["sha256"]
    assert raw["Digest"] == f"sha-256={frozen['sha256']}"


def test_operations_are_discoverable_with_schemas(users):
    listing = api(users["viewer"]).get("/api/v0/operations").json()
    names = {o["operation"] for o in listing}
    assert {"draft.update", "draft.freeze", "source.register_blob"} <= names
    assert "installation.claim_owner" not in names
    update = next(o for o in listing if o["operation"] == "draft.update")
    assert update["requires_expected_state"] is True
    assert "draft_id" in update["payload_schema"]["properties"]
