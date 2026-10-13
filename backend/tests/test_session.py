import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from specmate.access.operations import issue_owner_setup_token
from specmate.access.session import Login
from specmate.operations import Context, PermissionDenied, ValidationFailed, execute
from specmate.operations.models import IdempotencyRecord

pytestmark = pytest.mark.django_db
PASSWORD = "correct horse battery staple"


def post(client, path, body, csrf=True):
    headers = {"HTTP_X_CSRFTOKEN": client.cookies["csrftoken"].value} if csrf else {}
    return client.post(
        path, {"request_id": "session-test", **body}, content_type="application/json", **headers
    )


def test_anonymous_session_bootstraps_csrf_without_private_projects():
    client = Client(enforce_csrf_checks=True)
    response = client.get("/api/v0/session")
    assert response.json() == {"user": None, "owner_setup_required": True}
    assert client.cookies["csrftoken"].value
    assert client.get("/api/v0/projects").status_code == 401


def test_login_csrf_rotation_logout_and_fresh_profile():
    user = get_user_model().objects.create_user(username="local-user", password=PASSWORD)
    client = Client(enforce_csrf_checks=True)
    client.get("/api/v0/session")
    old_csrf = client.cookies["csrftoken"].value
    session = client.session
    session["pre_login"] = "anonymous"
    session.save()
    client.cookies["sessionid"] = session.session_key
    old_session = session.session_key
    body = {"username": user.username, "password": PASSWORD}
    assert post(client, "/api/v0/session/login", body, csrf=False).status_code == 403
    response = post(client, "/api/v0/session/login", body)
    assert response.status_code == 200, response.content
    assert response.json()["result"]["user"]["id"] == str(user.pk)
    assert client.cookies["csrftoken"].value != old_csrf
    assert client.cookies["sessionid"].value != old_session
    user.username = "renamed-user"
    user.save(update_fields=["username"])
    assert client.get("/api/v0/session").json()["user"]["username"] == "renamed-user"
    assert post(client, "/api/v0/session/logout", {}, csrf=False).status_code == 403
    assert post(client, "/api/v0/session/logout", {}).status_code == 200
    assert client.get("/api/v0/session").json()["user"] is None
    assert client.get("/api/v0/projects").status_code == 401
    assert not IdempotencyRecord.objects.exists()


def test_bad_missing_and_inactive_credentials_are_identical():
    get_user_model().objects.create_user(username="inactive", password=PASSWORD, is_active=False)
    get_user_model().objects.create_user(username="active", password=PASSWORD)
    client = Client(enforce_csrf_checks=True)
    client.get("/api/v0/session")
    results = [
        post(client, "/api/v0/session/login", {"username": name, "password": "wrong"})
        for name in ("active", "inactive", "missing")
    ]
    results.append(
        post(client, "/api/v0/session/login", {"username": "inactive", "password": PASSWORD})
    )
    assert {r.status_code for r in results} == {401}
    assert all(r.json() == results[0].json() for r in results)
    assert PASSWORD not in repr(Login(username="local", password=PASSWORD))


def test_disabled_account_profile_is_anonymous_and_cannot_mutate():
    user = get_user_model().objects.create_user(username="local-user", password=PASSWORD)
    client = Client(enforce_csrf_checks=True)
    client.force_login(user)
    client.get("/api/v0/session")
    get_user_model().objects.filter(pk=user.pk).update(is_active=False)
    assert client.get("/api/v0/session").json()["user"] is None
    assert client.get("/api/v0/projects").status_code == 401


@pytest.mark.parametrize("via", ["job", "mcp", "internal", "api"])
def test_session_operations_require_browser_request(via):
    user = get_user_model().objects.create_user(username="local-user", password=PASSWORD)
    ctx = Context(user=user, via=via, request_id="transport")
    with pytest.raises(PermissionDenied):
        execute("session.login", ctx, {"username": user.username, "password": PASSWORD})
    with pytest.raises(PermissionDenied):
        execute("session.logout", ctx, {})


def test_session_operations_refuse_generic_replay_keys():
    ctx = Context(user=None, via="api", request_id="transport", idempotency_key="session-key")
    with pytest.raises(ValidationFailed):
        execute("session.login", ctx, {"username": "local-user", "password": PASSWORD})
    assert not IdempotencyRecord.objects.exists()


def test_owner_claim_preserves_setup_then_login_logout():
    token, _ = issue_owner_setup_token()
    client = Client(enforce_csrf_checks=True)
    assert client.get("/api/v0/session").json()["owner_setup_required"]
    assert (
        post(
            client,
            "/api/v0/setup/owner",
            {"token": token, "username": "first-owner", "password": PASSWORD},
            csrf=False,
        ).status_code
        == 403
    )
    response = post(
        client,
        "/api/v0/setup/owner",
        {"token": token, "username": "first-owner", "password": PASSWORD},
    )
    assert response.status_code == 200, response.content
    state = client.get("/api/v0/session").json()
    assert state["user"]["username"] == "first-owner"
    assert not state["owner_setup_required"]
    assert post(client, "/api/v0/session/logout", {}).status_code == 200
    assert not client.get("/api/v0/session").json()["owner_setup_required"]
    assert (
        post(
            client, "/api/v0/session/login", {"username": "first-owner", "password": PASSWORD}
        ).status_code
        == 200
    )
