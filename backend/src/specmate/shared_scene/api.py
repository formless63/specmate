from uuid import UUID

from ninja import Router

from specmate.assemblies.contracts import ReadAssembly
from specmate.operations import Context
from specmate.shared_scene.operations import ListScenes, inspect_choices, inspect_scene

router = Router(tags=["shared scene"])


@router.get("/projects/{project_id}")
def choices(request, project_id: UUID):
    return inspect_choices(
        Context(user=request.user, via="api", request_id="scene-list"),
        ListScenes(project_id=project_id),
    )


@router.get("/snapshots/{snapshot_id}")
def inspect_snapshot(request, snapshot_id: UUID):
    return inspect_scene(
        Context(user=request.user, via="api", request_id="scene-read"),
        ReadAssembly(snapshot_id=snapshot_id),
    )
