from uuid import UUID

from pydantic import BaseModel, ConfigDict

from specmate.assemblies.contracts import ReadAssembly
from specmate.operations import Context, operation
from specmate.shared_scene.projection import list_scenes, read_scene


class ListScenes(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: UUID


@operation(
    "shared_scene.list",
    ListScenes,
    summary="List currently readable frozen assembly scenes in a project.",
    supports_idempotency=False,
)
def inspect_choices(ctx: Context, payload: ListScenes):
    return list_scenes(ctx.user, payload.project_id)


@operation(
    "shared_scene.read",
    ReadAssembly,
    summary="Inspect an exact assembly scene with current source authority and explicit unknowns.",
    supports_idempotency=False,
)
def inspect_scene(ctx: Context, payload: ReadAssembly):
    return read_scene(ctx.user, payload.snapshot_id)
