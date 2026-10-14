"""Workspace membership and roles; local accounts stay an installation-owner action.

All members read everything in a workspace. Only admins see the roster and change it,
under the workspace access-state token, and a workspace always keeps an active admin.
"""

from __future__ import annotations

import hashlib
import json
from typing import Literal
from uuid import UUID

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from pydantic import BaseModel, ConfigDict, Field

from specmate.access.account_names import LocalUsername
from specmate.access.models import GRANTABLE_PERMISSIONS, Installation, Workspace, WorkspaceMember
from specmate.access.permissions import Perm, authorize, membership, permissions_for
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)

Grant = Literal["build.execute", "inventory.manage", "design.freeze"]
if set(Grant.__args__) != set(GRANTABLE_PERMISSIONS):
    raise RuntimeError("Grantable permissions and the payload contract disagree.")


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkspaceRef(Payload):
    # Optional while an installation has exactly one workspace per member.
    workspace_id: UUID | None = None


class SetMember(WorkspaceRef):
    username: LocalUsername
    role: Literal["viewer", "contributor", "editor", "admin"]
    grants: list[Grant] = Field(default_factory=list, max_length=len(GRANTABLE_PERMISSIONS))


class RemoveMember(WorkspaceRef):
    username: LocalUsername


class CreateAccount(Payload):
    username: LocalUsername
    password: str = Field(min_length=1, max_length=512, repr=False)


def installation_workspace() -> Workspace:
    """The installation's single workspace, created on first use under the row lock."""
    installation, _ = Installation.objects.select_for_update().get_or_create(singleton=True)
    if installation.workspace_id is None:
        installation.workspace = Workspace.objects.create(name="Workspace")
        installation.save(update_fields=["workspace"])
    return installation.workspace


def actor_workspace_id(user, workspace_id: UUID | None) -> UUID:
    """Resolve an omitted workspace to the actor's only membership (NotFound for none)."""
    if workspace_id is not None:
        return workspace_id
    if user is None or not user.is_authenticated:
        raise NotFound("Not found.")
    ids = list(
        WorkspaceMember.objects.filter(user=user)
        .order_by("created_at")
        .values_list("workspace_id", flat=True)[:2]
    )
    if not ids:
        raise NotFound("Not found.")
    if len(ids) > 1:
        raise ValidationFailed("workspace_id is required for an actor in several workspaces.")
    return ids[0]


def state(workspace: Workspace) -> str:
    members = [
        {"user_id": m["user_id"], "role": m["role"], "grants": sorted(m["grants"])}
        for m in workspace.members.order_by("user_id").values("user_id", "role", "grants")
    ]
    body = json.dumps(
        {"name": workspace.name, "members": members}, sort_keys=True, separators=(",", ":")
    )
    return f"workspace:{workspace.id}:{hashlib.sha256(body.encode()).hexdigest()}"


def resolve(ctx, workspace_id, *, lock=False, permission=Perm.WORKSPACE_ADMIN) -> Workspace:
    workspace_id = actor_workspace_id(ctx.user, workspace_id)
    authorize(ctx.user, workspace_id, permission)
    query = Workspace.objects.select_for_update() if lock else Workspace.objects
    workspace = query.filter(id=workspace_id).first()
    if workspace is None:
        raise NotFound("Not found.")
    # An earlier administrator may have waited behind a concurrent revocation.
    authorize(ctx.user, workspace.id, permission)
    return workspace


def read_access(ctx, workspace_id) -> dict:
    workspace = resolve(ctx, workspace_id, permission=Perm.WORKSPACE_READ)
    own = membership(ctx.user, workspace.id)
    if own is None:
        raise NotFound("Not found.")
    held = permissions_for(own)
    result = {
        "workspace_id": str(workspace.id),
        "name": workspace.name,
        "role": own.role,
        "permissions": sorted(p.value for p in held),
    }
    if Perm.WORKSPACE_ADMIN in held:
        result["state"] = state(workspace)
        result["members"] = [
            {"username": m.user.get_username(), "role": m.role, "grants": sorted(m.grants)}
            for m in workspace.members.select_related("user").order_by("user__username")
        ]
    return result


def check_state(ctx, workspace) -> None:
    current = state(workspace)
    if ctx.require_expected_state() != current:
        raise Conflict(
            "Workspace access changed since expected state.", details={"current_state": current}
        )


def ensure_another_admin(workspace, user_id) -> None:
    if (
        not workspace.members.filter(role="admin", user__is_active=True)
        .exclude(user_id=user_id)
        .exists()
    ):
        raise ValidationFailed("A workspace must retain an active admin.")


def scope(ctx, p) -> str:
    workspace = authorize(
        ctx.user, actor_workspace_id(ctx.user, p.workspace_id), Perm.WORKSPACE_ADMIN
    )
    return f"workspace:{workspace.id}"


def replay(ctx, p, stored) -> None:
    resolve(ctx, p.workspace_id)


def is_installation_owner(user) -> bool:
    return Installation.objects.filter(owner=user).exists()


@operation(
    "account.create",
    CreateAccount,
    summary="Create a local account as installation owner (grants no membership).",
    supports_idempotency=False,
)
def create_account(ctx: Context, p: CreateAccount):
    if not is_installation_owner(ctx.user):
        raise PermissionDenied("Installation ownership is required.")
    User = get_user_model()
    candidate = User(username=p.username)
    try:
        validate_password(p.password, candidate)
    except DjangoValidationError as exc:
        raise ValidationFailed("Password rejected.", details={"reasons": exc.messages}) from None
    try:
        with transaction.atomic():
            account = User.objects.create_user(username=p.username, password=p.password)
    except IntegrityError:
        raise Conflict("Username is not available.") from None
    return {"username": account.get_username()}


@operation(
    "workspace.access",
    WorkspaceRef,
    summary="Read the actor's current workspace role and, for admins, the member roster.",
    supports_idempotency=False,
)
def inspect_access(ctx: Context, p: WorkspaceRef):
    return read_access(ctx, p.workspace_id)


@operation(
    "workspace.set_member",
    SetMember,
    summary="Add or update a workspace member's role and explicit grants.",
    requires_expected_state=True,
    idempotency_scope=scope,
    authorize_replay=replay,
)
def set_member(ctx: Context, p: SetMember):
    workspace = resolve(ctx, p.workspace_id, lock=True)
    check_state(ctx, workspace)
    account = get_user_model().objects.filter(username=p.username, is_active=True).first()
    if account is None:
        raise NotFound("Active local account not found.")
    prior = WorkspaceMember.objects.filter(workspace=workspace, user=account).first()
    if prior is not None and prior.role == "admin" and p.role != "admin":
        ensure_another_admin(workspace, account.pk)
    grants = sorted(set(p.grants))
    WorkspaceMember.objects.update_or_create(
        workspace=workspace, user=account, defaults={"role": p.role, "grants": grants}
    )
    return {
        "workspace_id": str(workspace.id),
        "state": state(workspace),
        "username": p.username,
        "role": p.role,
        "grants": grants,
    }


@operation(
    "workspace.remove_member",
    RemoveMember,
    summary="Remove a workspace member without leaving the workspace without an admin.",
    requires_expected_state=True,
    idempotency_scope=scope,
    authorize_replay=replay,
)
def remove_member(ctx: Context, p: RemoveMember):
    workspace = resolve(ctx, p.workspace_id, lock=True)
    check_state(ctx, workspace)
    member = workspace.members.select_related("user").filter(user__username=p.username).first()
    if member is None:
        raise NotFound("Workspace member not found.")
    if member.role == "admin":
        ensure_another_admin(workspace, member.user_id)
    member.delete()
    return {"workspace_id": str(workspace.id), "state": state(workspace), "username": p.username}
