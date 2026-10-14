"""Shared fixtures: two workspaces, one member per role, and membership helpers.

``users["owner"]`` is the admin, ``editor``, ``contributor`` and ``viewer`` hold those
roles in the primary workspace. ``outsider`` is not a member of it: the outsider
administers a separate foreign workspace, so "their" projects and items are genuinely
outside the primary workspace's privacy boundary.

Membership helpers (``member``, ``ensure_member``, ``remove_member``, ``set_grants``,
``membership``) accept ``project=`` (its workspace is used), ``workspace=`` or nothing
(the primary workspace). Roles accept the earlier ``owner`` name as ``admin``.
"""

import itertools

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import Project, Workspace, WorkspaceMember
from specmate.jobs.adapter import run_operation

_ids = itertools.count()

PRIMARY = "Synthetic workspace"
FOREIGN = "Foreign synthetic workspace"
ROLE_ORDER = ("viewer", "contributor", "editor", "admin")


@pytest.fixture(autouse=True)
def artifact_root(settings, tmp_path):
    settings.SPECMATE_ARTIFACT_ROOT = str(tmp_path / "artifacts")
    return tmp_path / "artifacts"


@pytest.fixture
def users(db):
    User = get_user_model()
    # Permission fixtures use job actors or force_login, never password authentication.
    # Session/account tests create their own users with real passwords and production hashing.
    accounts = {
        name: User.objects.create_user(username=name, password=None)
        for name in ("owner", "editor", "contributor", "viewer", "outsider")
    }
    primary = Workspace.objects.create(name=PRIMARY)
    foreign = Workspace.objects.create(name=FOREIGN)
    for name, role in (
        ("owner", "admin"),
        ("editor", "editor"),
        ("contributor", "contributor"),
        ("viewer", "viewer"),
    ):
        WorkspaceMember.objects.create(workspace=primary, user=accounts[name], role=role)
    WorkspaceMember.objects.create(workspace=foreign, user=accounts["outsider"], role="admin")
    return accounts


@pytest.fixture
def workspace(users):
    """Primary workspace id (str)."""
    return str(primary_workspace().id)


@pytest.fixture
def other_workspace(users):
    """Foreign workspace id (str); only ``users["outsider"]`` is a member."""
    return str(Workspace.objects.get(name=FOREIGN).id)


def primary_workspace():
    return Workspace.objects.get(name=PRIMARY)


def _workspace(project=None, workspace=None):
    if project is not None:
        return Project.objects.get(id=project).workspace
    if workspace is not None:
        return Workspace.objects.get(id=workspace)
    return primary_workspace()


def _role(role):
    return "admin" if role == "owner" else role


def membership(user, *, project=None, workspace=None):
    """The user's membership row in the selected workspace, or None."""
    return WorkspaceMember.objects.filter(
        workspace=_workspace(project, workspace), user=user
    ).first()


def member(user, role="viewer", *, project=None, workspace=None, grants=()):
    """Set exactly this role and these explicit grants (creating the membership)."""
    row, _ = WorkspaceMember.objects.update_or_create(
        workspace=_workspace(project, workspace),
        user=user,
        defaults={"role": _role(role), "grants": sorted(set(grants))},
    )
    return row


def ensure_member(user, role="viewer", *, project=None, workspace=None, grants=()):
    """Grant at least this role (never downgrading an existing membership)."""
    row = membership(user, project=project, workspace=workspace)
    role = _role(role)
    if row is None:
        return member(user, role, project=project, workspace=workspace, grants=grants)
    if ROLE_ORDER.index(role) > ROLE_ORDER.index(row.role):
        row.role = role
    row.grants = sorted(set(row.grants) | set(grants))
    row.save(update_fields=["role", "grants"])
    return row


def set_role(user, role, *, project=None, workspace=None):
    return WorkspaceMember.objects.filter(
        workspace=_workspace(project, workspace), user=user
    ).update(role=_role(role))


def set_grants(user, grants, *, project=None, workspace=None):
    return WorkspaceMember.objects.filter(
        workspace=_workspace(project, workspace), user=user
    ).update(grants=sorted(set(grants)))


def remove_member(user, *, project=None, workspace=None):
    """Remove the membership; returns the number of rows removed."""
    return WorkspaceMember.objects.filter(
        workspace=_workspace(project, workspace), user=user
    ).delete()[0]


def op(user, operation, payload, **ctx):
    """Invoke through the trusted jobs adapter (same execute() path as the API)."""
    return run_operation(
        on_behalf_of=user.pk,
        operation=operation,
        payload=payload,
        request_id=f"req-{next(_ids)}",
        **ctx,
    ).result


@pytest.fixture
def project(users):
    """A project in the primary workspace; every member sees it."""
    return op(users["owner"], "project.create", {"name": "Synthetic bench"})["project_id"]


@pytest.fixture
def definition(users, project, workspace):
    return op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "wire_stock",
            "name": "Demo stock",
            "content": {"a": 1},
        },
    )
