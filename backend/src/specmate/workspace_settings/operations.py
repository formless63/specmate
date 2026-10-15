"""Settings are explicit defaults; saving them never changes records or retained documents."""

from django.db import transaction

from specmate.access.models import Workspace
from specmate.access.permissions import Perm, authorize
from specmate.operations import Conflict, Context, operation
from specmate.workspace_settings.contracts import SettingsRef, UpdateSettings
from specmate.workspace_settings.contracts import WorkspaceSettings as Values
from specmate.workspace_settings.models import WorkspaceSettings


def describe(workspace_id):
    row = WorkspaceSettings.objects.filter(workspace_id=workspace_id).first()
    version = row.version if row else 0
    return {
        "workspace_id": str(workspace_id),
        "version": version,
        "state_token": f"workspace-settings:{workspace_id}:v{version}",
        "values": Values.model_validate(row.values if row else {}).model_dump(
            mode="json", by_alias=True, exclude_none=True
        ),
    }


@operation(
    "workspace.settings.get",
    SettingsRef,
    supports_idempotency=False,
    summary="Read workspace document defaults and optional numbering intent.",
    access=Perm.WORKSPACE_READ,
)
def get_settings(ctx: Context, p: SettingsRef):
    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_READ)
    return describe(workspace.id)


@operation(
    "workspace.settings.update",
    UpdateSettings,
    requires_expected_state=True,
    supports_idempotency=False,
    summary="Set reviewed workspace presentation and numbering defaults.",
    access=Perm.WORKSPACE_ADMIN,
)
def update_settings(ctx: Context, p: UpdateSettings):
    authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_ADMIN)
    with transaction.atomic():
        # Serialize the initial empty row as well as all subsequent updates.
        Workspace.objects.select_for_update().get(id=p.workspace_id)
        authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_ADMIN)
        current = describe(p.workspace_id)
        if ctx.require_expected_state() != current["state_token"]:
            raise Conflict(
                "Workspace settings changed since review.",
                details={"current_state": current["state_token"]},
            )
        row = WorkspaceSettings.objects.filter(workspace_id=p.workspace_id).first()
        values = p.values.model_dump(mode="json", by_alias=True, exclude_none=True)
        if row is None:
            WorkspaceSettings.objects.create(
                workspace_id=p.workspace_id, values=values, updated_by=ctx.user
            )
        else:
            row.values = values
            row.version += 1
            row.updated_by = ctx.user
            row.save()
        return describe(p.workspace_id)
