from uuid import UUID

from pydantic import BaseModel, ConfigDict

from specmate.access.permissions import Perm
from specmate.assemblies.contracts import ReadAssembly
from specmate.operations import Context, operation
from specmate.shared_scene.projection import list_scenes, preview_captured_scene, read_scene


class ListScenes(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Omitted means the actor's only workspace.
    workspace_id: UUID | None = None


@operation(
    "shared_scene.list",
    ListScenes,
    summary="List the latest frozen assembly scenes in the workspace collection.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def inspect_choices(ctx: Context, payload: ListScenes):
    return list_scenes(ctx.user, payload.workspace_id)


@operation(
    "shared_scene.read",
    ReadAssembly,
    summary="Inspect an exact assembly scene with current source authority and explicit unknowns.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def inspect_scene(ctx: Context, payload: ReadAssembly):
    return read_scene(ctx.user, payload.snapshot_id)


@operation(
    "shared_scene.preview_captured",
    ReadAssembly,
    summary="Preview an exact saved assembly capture without a frozen revision or qualification.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def inspect_captured_scene(ctx: Context, payload: ReadAssembly):
    return preview_captured_scene(ctx.user, payload.snapshot_id)
