"""Setting maker preferences. Workspace defaults need administration; a member's own
override needs only workspace read. Neither writes facts, ratings or evidence."""

from django.db import transaction

from specmate.access.permissions import Perm, authorize
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.preferences import queries
from specmate.preferences.contracts import KEYS, SetPreferences
from specmate.preferences.models import MakerPreferences


@operation(
    "preferences.set",
    SetPreferences,
    summary="Set workspace maker preferences or the caller's own override (defaults, not facts).",
    requires_expected_state=True,
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def set_preferences(ctx: Context, p: SetPreferences):
    needed = Perm.WORKSPACE_ADMIN if p.scope == "workspace" else Perm.WORKSPACE_READ
    workspace = authorize(ctx.user, p.workspace_id, needed)
    expected = ctx.require_expected_state()
    owner = None if p.scope == "workspace" else ctx.user
    changes = {key: getattr(p.values, key) for key in p.values.model_fields_set if key in KEYS}
    if not changes:
        raise ValidationFailed("No preference to change.")
    with transaction.atomic():
        row = (
            MakerPreferences.objects.select_for_update()
            .filter(workspace=workspace, user=owner)
            .first()
        )
        if queries.token(row) != expected:
            raise Conflict(
                "Preferences changed since they were read.",
                details={"current_state": queries.token(row)},
            )
        values = dict(row.values) if row else {}
        for key, value in changes.items():
            if value is None:
                values.pop(key, None)
            else:
                values[key] = value
        if row is None:
            MakerPreferences.objects.create(
                workspace=workspace, user=owner, values=values, updated_by=ctx.user
            )
        else:
            row.values = values
            row.version += 1
            row.updated_by = ctx.user
            row.save()
    return queries.describe_preferences(workspace.id, ctx.user)
