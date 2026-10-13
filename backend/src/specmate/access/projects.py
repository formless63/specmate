"""Private team scopes share the same engineering identities and operation authority."""

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
from specmate.access.models import Installation, Membership, Project
from specmate.access.permissions import Perm, authorize, permissions_for
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)
from specmate.operations.scope import project_scope


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectRef(Payload):
    project_id: UUID


class RenameProject(ProjectRef):
    name: str = Field(min_length=1, max_length=200)


class SetMember(ProjectRef):
    username: LocalUsername
    role: Literal["owner", "editor", "viewer"]
    grants: list[Perm] = Field(default_factory=list, max_length=len(Perm))


class RemoveMember(ProjectRef):
    username: LocalUsername


class CreateAccount(Payload):
    username: LocalUsername
    password: str = Field(min_length=1, max_length=512, repr=False)


def state(project):
    members = list(project.memberships.order_by("user_id").values("user_id", "role", "grants"))
    body = json.dumps(
        {"name": project.name, "members": members}, sort_keys=True, separators=(",", ":")
    )
    return f"project:{project.id}:{hashlib.sha256(body.encode()).hexdigest()}"


def resolve(ctx, project_id, *, lock=False, permission=Perm.PROJECT_ADMIN):
    authorize(ctx.user, project_id, permission)
    query = Project.objects.select_for_update() if lock else Project.objects
    project = query.filter(id=project_id).first()
    if project is None:
        raise NotFound("Project not found.")
    # A previous administrator may have waited behind a concurrent revocation.
    authorize(ctx.user, project_id, permission)
    return project


def read_access(ctx, project_id):
    project = resolve(ctx, project_id, lock=True, permission=Perm.PROJECT_READ)
    own = Membership.objects.filter(project=project, user=ctx.user).first()
    if own is None:
        raise NotFound("Project not found.")
    result = {
        "project_id": str(project.id),
        "name": project.name,
        "permissions": sorted(p.value for p in permissions_for(own)),
    }
    if Perm.PROJECT_ADMIN in permissions_for(own):
        result["state"] = state(project)
        result["members"] = [
            {"username": m.user.get_username(), "role": m.role, "grants": sorted(m.grants)}
            for m in project.memberships.select_related("user").order_by("user__username")
        ]
    return result


def check_state(ctx, project):
    current = state(project)
    if ctx.require_expected_state() != current:
        raise Conflict(
            "Project access changed since expected state.", details={"current_state": current}
        )


def scope(ctx, p):
    return project_scope(ctx, p.project_id, Perm.PROJECT_ADMIN)


def replay(ctx, p, stored):
    resolve(ctx, p.project_id)


def is_installation_owner(user):
    return Installation.objects.filter(owner=user).exists()


@operation(
    "account.create",
    CreateAccount,
    summary="Create a local account as installation owner.",
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
    "project.access",
    ProjectRef,
    summary="Read current project permissions and authorized team roster.",
    supports_idempotency=False,
)
def inspect_access(ctx: Context, p: ProjectRef):
    return read_access(ctx, p.project_id)


@operation(
    "project.rename",
    RenameProject,
    summary="Rename a private project under its access state token.",
    requires_expected_state=True,
    idempotency_scope=scope,
    authorize_replay=replay,
)
def rename_project(ctx: Context, p: RenameProject):
    project = resolve(ctx, p.project_id, lock=True)
    check_state(ctx, project)
    project.name = p.name
    project.save(update_fields=["name"])
    return read_access(ctx, project.id)


@operation(
    "project.set_member",
    SetMember,
    summary="Add or update a local project member and explicit grants.",
    requires_expected_state=True,
    idempotency_scope=scope,
    authorize_replay=replay,
)
def set_member(ctx: Context, p: SetMember):
    project = resolve(ctx, p.project_id, lock=True)
    check_state(ctx, project)
    account = get_user_model().objects.filter(username=p.username, is_active=True).first()
    if account is None:
        raise NotFound("Active local account not found.")
    prior = Membership.objects.filter(project=project, user=account).first()
    if prior is not None and prior.role == "owner" and p.role != "owner":
        ensure_another_owner(project, account.pk)
    Membership.objects.update_or_create(
        project=project,
        user=account,
        defaults={"role": p.role, "grants": sorted({g.value for g in p.grants})},
    )
    return {
        "project_id": str(project.id),
        "state": state(project),
        "username": p.username,
        "role": p.role,
        "grants": sorted({g.value for g in p.grants}),
    }


def ensure_another_owner(project, user_id):
    if (
        not project.memberships.filter(role="owner", user__is_active=True)
        .exclude(user_id=user_id)
        .exists()
    ):
        raise ValidationFailed("A project must retain an active owner.")


@operation(
    "project.remove_member",
    RemoveMember,
    summary="Remove a project member without orphaning its ownership.",
    requires_expected_state=True,
    idempotency_scope=scope,
    authorize_replay=replay,
)
def remove_member(ctx: Context, p: RemoveMember):
    project = resolve(ctx, p.project_id, lock=True)
    check_state(ctx, project)
    member = project.memberships.select_related("user").filter(user__username=p.username).first()
    if member is None:
        raise NotFound("Project member not found.")
    if member.role == "owner":
        ensure_another_owner(project, member.user_id)
    member.delete()
    return {"project_id": str(project.id), "state": state(project), "username": p.username}
