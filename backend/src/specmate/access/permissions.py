"""Workspace-scoped authorization, evaluated in the operation layer for every transport.

The workspace is the privacy boundary (docs/SECURITY.md "Workspace roles"). Every member
reads every record in it; the member's role and explicit grants decide what they may
change. Non-members receive NotFound, never a denial, so existence does not leak.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from specmate.access.models import Project, Workspace, WorkspaceMember
from specmate.operations import NotFound, PermissionDenied


class Perm(StrEnum):
    """Stable permission atoms; machine clients and agents may hold a subset."""

    WORKSPACE_READ = "workspace.read"
    WORKSPACE_ADMIN = "workspace.admin"
    ITEM_CREATE = "item.create"
    PROJECT_EDIT = "project.edit"
    DESIGN_EDIT = "design.edit"
    DESIGN_FREEZE = "design.freeze"
    SOURCE_REGISTER = "source.register"
    BUILD_EXECUTE = "build.execute"
    INVENTORY_MANAGE = "inventory.manage"
    INVENTORY_RESERVE = "inventory.reserve"


Role = WorkspaceMember.Role

_VIEWER = frozenset({Perm.WORKSPACE_READ})
_CONTRIBUTOR = _VIEWER | {Perm.ITEM_CREATE, Perm.SOURCE_REGISTER, Perm.PROJECT_EDIT}
_EDITOR = _CONTRIBUTOR | {Perm.DESIGN_EDIT, Perm.DESIGN_FREEZE, Perm.INVENTORY_RESERVE}

# Native execution and inventory management stay separate authorities: only admins hold
# them by role; any member may receive them as explicit grants.
ROLE_PERMISSIONS: dict[str, frozenset[Perm]] = {
    Role.VIEWER: _VIEWER,
    Role.CONTRIBUTOR: _CONTRIBUTOR,
    Role.EDITOR: _EDITOR,
    Role.ADMIN: frozenset(Perm),
}
GRANTABLE: frozenset[Perm] = frozenset(
    {Perm.BUILD_EXECUTE, Perm.INVENTORY_MANAGE, Perm.DESIGN_FREEZE}
)


@dataclass(frozen=True)
class Delegation:
    """A bounded grant under which one account's authority is evaluated (agent runs).

    While active, that account is a member of ``workspace_id`` only, and its permissions
    there are capped to ``permissions`` (never widened). Other accounts are unaffected.
    """

    user_id: Any
    workspace_id: str
    permissions: frozenset[Perm]


_delegation: ContextVar[Delegation | None] = ContextVar("specmate_delegation", default=None)


@contextmanager
def delegated(user_id: Any, workspace_id: Any, permissions: frozenset[Perm]) -> Iterator[None]:
    token = _delegation.set(Delegation(user_id, str(workspace_id), frozenset(permissions)))
    try:
        yield
    finally:
        _delegation.reset(token)


# Membership rows reused inside one synchronous read traversal (see `memoized_membership`).
_membership_memo: ContextVar[dict | None] = ContextVar("specmate_membership_memo", default=None)


@contextmanager
def memoized_membership() -> Iterator[None]:
    """Read each (actor, workspace) membership at most once inside this block.

    Only for bounded, read-only traversals (closure authorization): the memo lives for the
    block, never across operations or requests. Nested blocks share the outer memo.
    Delegation bounds are still applied on every call.
    """
    if _membership_memo.get() is not None:
        yield
        return
    token = _membership_memo.set({})
    try:
        yield
    finally:
        _membership_memo.reset(token)


def _delegation_for(user_id: Any) -> Delegation | None:
    current = _delegation.get()
    return current if current is not None and current.user_id == user_id else None


def permissions_for(member: WorkspaceMember) -> frozenset[Perm]:
    granted = {Perm(g) for g in member.grants if g in GRANTABLE}
    permissions = ROLE_PERMISSIONS[member.role] | granted
    if Perm.INVENTORY_MANAGE in permissions:
        permissions |= {Perm.INVENTORY_RESERVE}
    bound = _delegation_for(member.user_id)
    if bound is not None:
        permissions &= bound.permissions
    return frozenset(permissions)


def _authenticated(user: Any) -> bool:
    return user is not None and user.is_authenticated


def membership(user: Any, workspace_id: Any) -> WorkspaceMember | None:
    """The actor's current membership in a workspace, read fresh from the database."""
    if not _authenticated(user) or workspace_id is None:
        return None
    bound = _delegation_for(user.pk)
    if bound is not None and str(workspace_id) != bound.workspace_id:
        return None
    memo = _membership_memo.get()
    key = (user.pk, str(workspace_id))
    if memo is not None and key in memo:
        return memo[key]
    member = (
        WorkspaceMember.objects.select_related("workspace")
        .filter(workspace_id=workspace_id, user=user)
        .first()
    )
    if memo is not None:
        memo[key] = member
    return member


def member_workspaces(user: Any):
    if not _authenticated(user):
        return Workspace.objects.none()
    bound = _delegation_for(user.pk)
    if bound is not None:
        return Workspace.objects.filter(members__user=user, id=bound.workspace_id)
    return Workspace.objects.filter(members__user=user)


def visible_projects(user: Any):
    """Every project in the actor's workspaces; projects are not separate access scopes."""
    if not _authenticated(user):
        return Project.objects.none()
    bound = _delegation_for(user.pk)
    if bound is not None:
        return Project.objects.filter(
            workspace__members__user=user, workspace_id=bound.workspace_id
        )
    return Project.objects.filter(workspace__members__user=user)


def _resolve(user: Any, workspace_id: Any) -> WorkspaceMember:
    member = membership(user, workspace_id)
    if member is None:
        # One message for missing and unreadable scopes, so existence never leaks.
        raise NotFound("Not found.")
    return member


def authorize(user: Any, workspace_id: Any, perm: Perm) -> Workspace:
    """Return the workspace if the actor holds perm there. Non-members get NotFound."""
    member = _resolve(user, workspace_id)
    if perm not in permissions_for(member):
        raise PermissionDenied(f"Missing permission {perm.value}.")
    return member.workspace


def held_permissions(user: Any, workspace_id: Any) -> frozenset[Perm]:
    """Current permissions of a member (NotFound for non-members)."""
    return permissions_for(_resolve(user, workspace_id))


def authorize_item(user: Any, item: Any, perm: Perm) -> Workspace:
    """Object-level rule: contributors edit drafts of the items they created.

    ``item`` carries ``workspace_id`` and ``created_by_id``. Freezing, reviews and every
    other permission are never widened by authorship.
    """
    member = _resolve(user, item.workspace_id)
    held = permissions_for(member)
    if perm in held:
        return member.workspace
    if (
        perm == Perm.DESIGN_EDIT
        and Perm.ITEM_CREATE in held
        and getattr(item, "created_by_id", None) == user.pk
    ):
        return member.workspace
    raise PermissionDenied(f"Missing permission {perm.value}.")


def authorize_project(user: Any, project_id: Any, perm: Perm, *, lock: bool = False) -> Project:
    """Resolve a project-held context: the project's workspace role decides authority."""
    query = Project.objects.select_related("workspace")
    if lock:
        query = query.select_for_update(of=("self",))
    project = query.filter(id=project_id).first()
    if project is None or membership(user, project.workspace_id) is None:
        raise NotFound("Project not found.")
    authorize(user, project.workspace_id, perm)
    return project


def context_project(project_id: Any, workspace: Workspace | Any) -> Project | None:
    """The optional navigation project of a workspace request; it must be in the workspace.

    Context never grants or limits access: it only filters or labels. A project outside
    the (already authorized) workspace is indistinguishable from a missing one.
    """
    if project_id is None:
        return None
    workspace_id = getattr(workspace, "id", workspace)
    project = Project.objects.filter(id=project_id, workspace_id=workspace_id).first()
    if project is None:
        raise NotFound("Project not found.")
    return project
