from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from django.contrib.auth import get_user_model, login
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from pydantic import BaseModel, ConfigDict, Field

from specmate.access.account_names import LocalUsername
from specmate.access.models import Installation, OwnerSetupToken, WorkspaceMember
from specmate.access.workspaces import installation_workspace
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.operations.core import ACCESS_PUBLIC

OWNER_TOKEN_LIFETIME = timedelta(minutes=30)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_owner_setup_token() -> tuple[str, OwnerSetupToken]:
    """Operator/CLI path: create a fresh token, revoking unused older ones."""
    with transaction.atomic():
        installation, _ = Installation.objects.select_for_update().get_or_create(singleton=True)
        if installation.owner_id is not None:
            raise Conflict("This installation already has an owner.")
        now = timezone.now()
        OwnerSetupToken.objects.filter(used_at__isnull=True, revoked_at__isnull=True).update(
            revoked_at=now
        )
        token = secrets.token_urlsafe(32)
        record = OwnerSetupToken.objects.create(
            token_sha256=_hash(token), expires_at=now + OWNER_TOKEN_LIFETIME
        )
    return token, record


class ClaimOwner(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=20, max_length=200, repr=False)
    username: LocalUsername
    password: str = Field(min_length=1, max_length=512, repr=False)


@operation(
    "installation.claim_owner",
    ClaimOwner,
    summary="Claim installation ownership with a one-time setup token.",
    public=True,
    access=ACCESS_PUBLIC,
)
def claim_owner(ctx: Context, p: ClaimOwner) -> dict:
    installation, _ = Installation.objects.select_for_update().get_or_create(singleton=True)
    now = timezone.now()
    record = OwnerSetupToken.objects.select_for_update().filter(token_sha256=_hash(p.token)).first()
    # One generic message for every token failure.
    if (
        installation.owner_id is not None
        or record is None
        or record.used_at is not None
        or record.revoked_at is not None
        or record.expires_at <= now
    ):
        raise ValidationFailed("Setup token is invalid or expired.")
    User = get_user_model()
    if User.objects.filter(username=p.username).exists():
        raise ValidationFailed("Username is not available.")
    candidate = User(username=p.username)
    try:
        validate_password(p.password, candidate)
    except DjangoValidationError as exc:
        raise ValidationFailed("Password rejected.", details={"reasons": exc.messages}) from None
    user = User.objects.create_user(username=p.username, password=p.password)
    installation.owner = user
    installation.save(update_fields=["owner"])
    # The installation owner claims the first admin membership of the workspace.
    workspace = installation_workspace()
    WorkspaceMember.objects.update_or_create(
        workspace=workspace, user=user, defaults={"role": WorkspaceMember.Role.ADMIN}
    )
    record.used_at = now
    record.save(update_fields=["used_at"])
    if ctx.request is not None:
        login(ctx.request, user)
    return {
        "installation_id": str(installation.installation_id),
        "owner": user.username,
        "workspace_id": str(workspace.id),
    }
