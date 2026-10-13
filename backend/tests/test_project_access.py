"""Personal and team projects keep scope private across every command path."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.test import Client

from specmate.access.models import Installation, Membership
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord
from specmate.queries import list_projects

from .conftest import op


def current(users, project):
    return op(users["owner"], "project.access", {"project_id": project})


def set_member(users, project, username, role="viewer", grants=(), **context):
    return op(
        users["owner"],
        "project.set_member",
        {
            "project_id": project,
            "username": username,
            "role": role,
            "grants": list(grants),
        },
        **context,
    )


def test_uninvited_actor_cannot_enumerate_private_names_members_or_mutate(users, project):
    assert list_projects(users["outsider"]) == []
    for name, payload in [
        ("project.access", {}),
        ("project.rename", {"name": "Hijacked"}),
        ("project.set_member", {"username": "outsider", "role": "owner"}),
        ("project.remove_member", {"username": "owner"}),
    ]:
        with pytest.raises(NotFound):
            op(
                users["outsider"],
                name,
                {"project_id": project, **payload},
                expected_state="unknown",
            )
    viewer = op(users["viewer"], "project.access", {"project_id": project})
    assert "members" not in viewer and "state" not in viewer
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "project.rename",
            {"project_id": project, "name": "Denied"},
            expected_state="unknown",
        )


def test_explicit_team_grants_and_removal_use_the_same_design_models(users, project):
    before = current(users, project)
    changed = set_member(
        users, project, "outsider", "editor", ["design.freeze"], expected_state=before["state"]
    )
    assert changed["state"] != before["state"]
    shared = list_projects(users["outsider"])
    assert len(shared) == 1 and "design.freeze" in shared[0]["permissions"]
    definition = op(
        users["outsider"],
        "definition.create",
        {
            "project_id": project,
            "kind": "part",
            "name": "Team component",
        },
    )
    frozen = op(
        users["outsider"],
        "draft.freeze",
        {"draft_id": definition["draft_id"]},
        expected_state=definition["state"],
    )
    assert frozen["revision_id"]
    op(
        users["owner"],
        "project.remove_member",
        {"project_id": project, "username": "outsider"},
        expected_state=changed["state"],
    )
    assert list_projects(users["outsider"]) == []
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "draft.update",
            {"draft_id": definition["draft_id"], "changes": {}},
            expected_state=frozen["draft"]["state"],
        )


def test_stale_project_access_and_invalid_grants_leave_members_unchanged(users, project):
    before = current(users, project)
    changed = set_member(
        users, project, "editor", "editor", ["design.freeze"], expected_state=before["state"]
    )
    with pytest.raises(Conflict) as error:
        set_member(users, project, "viewer", "owner", expected_state=before["state"])
    assert error.value.details == {"current_state": changed["state"]}
    with pytest.raises(ValidationFailed):
        set_member(
            users,
            project,
            "viewer",
            "viewer",
            ["made-up.permission"],
            expected_state=changed["state"],
        )
    assert Membership.objects.get(project_id=project, user=users["viewer"]).role == "viewer"


def test_last_active_owner_cannot_be_removed_or_demoted(users, project):
    token = current(users, project)["state"]
    for operation, payload in [
        ("project.remove_member", {"username": "owner"}),
        ("project.set_member", {"username": "owner", "role": "viewer"}),
    ]:
        with pytest.raises(ValidationFailed):
            op(users["owner"], operation, {"project_id": project, **payload}, expected_state=token)
    assert current(users, project)["state"] == token
    changed = set_member(users, project, "editor", "owner", expected_state=token)
    removed = op(
        users["owner"],
        "project.remove_member",
        {"project_id": project, "username": "owner"},
        expected_state=changed["state"],
    )
    assert removed["state"] != changed["state"]
    assert list_projects(users["owner"]) == []
    assert "state" in op(users["editor"], "project.access", {"project_id": project})


def test_keyed_mutation_replays_but_rechecks_current_administration(users, project):
    payload = {"project_id": project, "name": "Reviewed shared project"}
    token = current(users, project)["state"]
    first = op(
        users["owner"], "project.rename", payload, expected_state=token, idempotency_key="rename"
    )
    assert (
        op(
            users["owner"],
            "project.rename",
            payload,
            expected_state=token,
            idempotency_key="rename",
        )
        == first
    )
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "project.rename",
            {**payload, "name": "Changed"},
            expected_state=token,
            idempotency_key="rename",
        )
    Membership.objects.filter(project_id=project, user=users["owner"]).update(role="viewer")
    with pytest.raises(PermissionDenied):
        op(
            users["owner"],
            "project.rename",
            payload,
            expected_state=token,
            idempotency_key="rename",
        )
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "project.access", {"project_id": project}, idempotency_key="live")


def test_only_installation_owner_creates_email_free_accounts_without_caching_password(users):
    Installation.objects.create(owner=users["owner"])
    payload = {"username": "new-local-member", "password": "independent-account-secret-7826"}
    with pytest.raises(PermissionDenied):
        op(users["editor"], "account.create", payload)
    with pytest.raises(ValidationFailed):
        op(users["owner"], "account.create", payload, idempotency_key="credentials")
    result = op(users["owner"], "account.create", payload)
    assert result == {"username": payload["username"]}
    account = get_user_model().objects.get(username=payload["username"])
    assert account.email == "" and account.check_password(payload["password"])
    assert not IdempotencyRecord.objects.filter(operation="account.create").exists()
    with pytest.raises(Conflict):
        op(users["owner"], "account.create", payload)


def test_http_adapter_cannot_bypass_shared_team_authority(users, project):
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data={
            "operation": "project.set_member",
            "request_id": "http-team",
            "expected_state": current(users, project)["state"],
            "payload": {"project_id": project, "username": "outsider", "role": "viewer"},
        },
        content_type="application/json",
    )
    assert response.status_code == 200
    client.force_login(users["outsider"])
    assert client.get("/api/v0/projects").json()[0]["project_id"] == project
    denied = client.post(
        "/api/v0/operations",
        data={
            "operation": "project.remove_member",
            "request_id": "http-denied",
            "expected_state": response.json()["result"]["state"],
            "payload": {"project_id": project, "username": "owner"},
        },
        content_type="application/json",
    )
    assert denied.status_code == 403


@pytest.mark.django_db(transaction=True)
def test_concurrent_team_changes_have_one_winner_and_preserve_owner(users, project):
    gate = Barrier(2)
    token = current(users, project)["state"]

    def update(username):
        close_old_connections()
        try:
            gate.wait(timeout=10)
            return set_member(
                users, project, username, "editor", ["design.freeze"], expected_state=token
            )
        except Conflict:
            return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(update, ["editor", "viewer"]))
    assert outcomes.count("conflict") == 1
    assert Membership.objects.filter(project_id=project, role="owner").count() == 1


def test_username_normalization_is_validated_before_account_creation(users):
    from pydantic import ValidationError

    from specmate.access.operations import ClaimOwner
    from specmate.access.projects import CreateAccount

    payload = {"username": "ﬃ" * 150, "password": "independent-account-secret-7826"}
    for contract, extras in [(CreateAccount, {}), (ClaimOwner, {"token": "t" * 32})]:
        with pytest.raises(ValidationError):
            contract.model_validate({**payload, **extras})
    Installation.objects.create(owner=users["owner"])
    with pytest.raises(ValidationFailed):
        op(users["owner"], "account.create", payload)
    normalized_payload = {**payload, "username": "\uff26\uff41\uff43\uff54Member"}
    canonical = CreateAccount.model_validate(normalized_payload)
    assert canonical.username == "FactMember"
    created = op(users["owner"], "account.create", normalized_payload)
    assert created == {"username": "FactMember"}


def test_unicode_account_name_uses_the_same_normalization_in_browser_login(users):
    Installation.objects.create(owner=users["owner"])
    name = "\uff26\uff41\uff43\uff54Member"
    password = "independent-account-secret-7826"
    op(users["owner"], "account.create", {"username": name, "password": password})
    client = Client()
    result = client.post(
        "/api/v0/session/login",
        data={"request_id": "normalized-login", "username": name, "password": password},
        content_type="application/json",
    )
    assert result.status_code == 200
    assert result.json()["result"]["user"]["username"] == "FactMember"
