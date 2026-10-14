"""FND-007: one private workspace whose members share every record; roles decide changes."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.test import Client

from specmate.access.models import Installation, WorkspaceMember
from specmate.access.permissions import ROLE_PERMISSIONS, Perm, held_permissions
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord
from specmate.queries import list_projects

from .conftest import member, op


def current(users):
    return op(users["owner"], "workspace.access", {})


def set_member(users, username, role="viewer", grants=(), **context):
    return op(
        users["owner"],
        "workspace.set_member",
        {"username": username, "role": role, "grants": list(grants)},
        **context,
    )


def test_role_table_matches_the_accepted_model():
    assert ROLE_PERMISSIONS["viewer"] == {Perm.WORKSPACE_READ}
    assert ROLE_PERMISSIONS["contributor"] == {
        Perm.WORKSPACE_READ,
        Perm.ITEM_CREATE,
        Perm.SOURCE_REGISTER,
        Perm.PROJECT_EDIT,
    }
    assert ROLE_PERMISSIONS["editor"] == ROLE_PERMISSIONS["contributor"] | {
        Perm.DESIGN_EDIT,
        Perm.DESIGN_FREEZE,
        Perm.INVENTORY_RESERVE,
    }
    assert ROLE_PERMISSIONS["admin"] == set(Perm)
    # Native execution and inventory management are never implied by non-admin roles.
    for role in ("viewer", "contributor", "editor"):
        assert not {Perm.BUILD_EXECUTE, Perm.INVENTORY_MANAGE} & ROLE_PERMISSIONS[role]


def test_explicit_grants_add_separate_authorities(users, workspace):
    member(users["editor"], "editor", grants=["build.execute", "inventory.manage"])
    held = held_permissions(users["editor"], workspace)
    assert {Perm.BUILD_EXECUTE, Perm.INVENTORY_MANAGE, Perm.INVENTORY_RESERVE} <= held
    assert Perm.WORKSPACE_ADMIN not in held


def test_members_see_every_project_and_non_members_see_nothing(users, workspace, project):
    second = op(users["contributor"], "project.create", {"name": "Contributor bench"})
    for name in ("owner", "editor", "contributor", "viewer"):
        listed = {row["project_id"] for row in list_projects(users[name])}
        assert listed == {project, second["project_id"]}
    assert list_projects(users["outsider"]) == []
    viewer = op(users["viewer"], "workspace.access", {})
    assert viewer["role"] == "viewer" and viewer["permissions"] == ["workspace.read"]
    assert "members" not in viewer and "state" not in viewer
    for name, payload in [
        ("workspace.access", {}),
        ("workspace.set_member", {"username": "outsider", "role": "admin"}),
        ("workspace.remove_member", {"username": "owner"}),
        ("project.references", {"project_id": project}),
        ("project.rename", {"project_id": project, "name": "Hijacked"}),
    ]:
        with pytest.raises(NotFound):
            op(
                users["outsider"],
                name,
                {"workspace_id": workspace, **payload} if name.startswith("workspace") else payload,
                expected_state="unknown",
            )
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "workspace.set_member",
            {"username": "outsider", "role": "viewer"},
            expected_state="unknown",
        )


def test_membership_grants_and_removal_use_the_same_design_models(users, workspace, project):
    before = current(users)
    changed = op(
        users["owner"],
        "workspace.set_member",
        {
            "workspace_id": workspace,
            "username": "outsider",
            "role": "contributor",
            "grants": ["design.freeze"],
        },
        expected_state=before["state"],
    )
    assert changed["state"] != before["state"]
    shared = [row for row in list_projects(users["outsider"]) if row["project_id"] == project]
    assert len(shared) == 1 and "design.freeze" in shared[0]["permissions"]
    definition = op(
        users["outsider"],
        "definition.create",
        {"workspace_id": workspace, "kind": "part", "name": "Team component"},
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
        "workspace.remove_member",
        {"workspace_id": workspace, "username": "outsider"},
        expected_state=changed["state"],
    )
    assert all(row["project_id"] != project for row in list_projects(users["outsider"]))
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "draft.update",
            {"draft_id": definition["draft_id"], "changes": {}},
            expected_state=frozen["draft"]["state"],
        )


def test_stale_access_and_invalid_grants_leave_members_unchanged(users, workspace):
    before = current(users)
    changed = set_member(
        users, "editor", "editor", ["build.execute"], expected_state=before["state"]
    )
    with pytest.raises(Conflict) as error:
        set_member(users, "viewer", "admin", expected_state=before["state"])
    assert error.value.details == {"current_state": changed["state"]}
    for grants in (["made-up.permission"], ["design.edit"], ["workspace.admin"]):
        with pytest.raises(ValidationFailed):
            set_member(users, "viewer", "viewer", grants, expected_state=changed["state"])
    with pytest.raises(ValidationFailed):
        set_member(users, "viewer", "owner", expected_state=changed["state"])
    assert (
        WorkspaceMember.objects.get(user=users["viewer"], workspace_id=workspace).role == "viewer"
    )


def test_last_active_admin_cannot_be_removed_or_demoted(users):
    token = current(users)["state"]
    for operation, payload in [
        ("workspace.remove_member", {"username": "owner"}),
        ("workspace.set_member", {"username": "owner", "role": "editor"}),
    ]:
        with pytest.raises(ValidationFailed):
            op(users["owner"], operation, payload, expected_state=token)
    assert current(users)["state"] == token
    changed = set_member(users, "editor", "admin", expected_state=token)
    removed = op(
        users["owner"],
        "workspace.remove_member",
        {"username": "owner"},
        expected_state=changed["state"],
    )
    assert removed["state"] != changed["state"]
    assert list_projects(users["owner"]) == []
    assert "state" in op(users["editor"], "workspace.access", {})


def test_keyed_mutation_replays_but_rechecks_current_administration(users, workspace):
    token = current(users)["state"]
    payload = {"username": "viewer", "role": "contributor", "grants": []}
    first = op(
        users["owner"],
        "workspace.set_member",
        payload,
        expected_state=token,
        idempotency_key="member",
    )
    assert (
        op(
            users["owner"],
            "workspace.set_member",
            payload,
            expected_state=token,
            idempotency_key="member",
        )
        == first
    )
    assert IdempotencyRecord.objects.get().scope == f"workspace:{workspace}"
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "workspace.set_member",
            {**payload, "role": "editor"},
            expected_state=token,
            idempotency_key="member",
        )
    member(users["editor"], "admin")
    member(users["owner"], "editor")
    with pytest.raises(PermissionDenied):
        op(
            users["owner"],
            "workspace.set_member",
            payload,
            expected_state=token,
            idempotency_key="member",
        )
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "workspace.access", {}, idempotency_key="live")


def test_actor_in_several_workspaces_must_name_one(users, workspace, other_workspace):
    member(users["outsider"], "viewer", workspace=workspace)
    with pytest.raises(ValidationFailed):
        op(users["outsider"], "workspace.access", {})
    with pytest.raises(ValidationFailed):
        op(users["outsider"], "project.create", {"name": "Ambiguous"})
    named = op(users["outsider"], "workspace.access", {"workspace_id": other_workspace})
    assert named["role"] == "admin" and named["workspace_id"] == other_workspace


def test_only_installation_owner_creates_accounts_which_grant_no_membership(users):
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
    assert not WorkspaceMember.objects.filter(user=account).exists()
    assert list_projects(account) == []
    assert not IdempotencyRecord.objects.filter(operation="account.create").exists()
    with pytest.raises(Conflict):
        op(users["owner"], "account.create", payload)


def test_http_adapter_cannot_bypass_shared_workspace_authority(users, workspace, project):
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data={
            "operation": "workspace.set_member",
            "request_id": "http-team",
            "expected_state": current(users)["state"],
            "payload": {
                "workspace_id": workspace,
                "username": "contributor",
                "role": "viewer",
            },
        },
        content_type="application/json",
    )
    assert response.status_code == 200
    client.force_login(users["viewer"])
    assert client.get("/api/v0/projects").json()[0]["project_id"] == project
    access = client.get("/api/v0/access/workspace").json()
    assert access["role"] == "viewer" and "members" not in access
    denied = client.post(
        "/api/v0/operations",
        data={
            "operation": "workspace.remove_member",
            "request_id": "http-denied",
            "expected_state": response.json()["result"]["state"],
            "payload": {"username": "owner"},
        },
        content_type="application/json",
    )
    assert denied.status_code == 403
    client.force_login(users["outsider"])
    detail = client.get(f"/api/v0/access/projects/{project}")
    assert detail.status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_membership_changes_have_one_winner_and_keep_an_admin(users):
    gate = Barrier(2)
    token = current(users)["state"]

    def update(username):
        close_old_connections()
        try:
            gate.wait(timeout=10)
            return set_member(users, username, "editor", ["build.execute"], expected_state=token)
        except Conflict:
            return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(update, ["editor", "viewer"]))
    assert outcomes.count("conflict") == 1
    assert WorkspaceMember.objects.filter(role="admin", user=users["owner"]).count() == 1


def test_username_normalization_is_validated_before_account_creation(users):
    from pydantic import ValidationError

    from specmate.access.operations import ClaimOwner
    from specmate.access.workspaces import CreateAccount

    payload = {"username": "\ufb03" * 150, "password": "independent-account-secret-7826"}
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
