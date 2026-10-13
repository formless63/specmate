import hashlib
from uuid import UUID

from django.http import HttpResponse
from ninja import Router

from specmate.assemblies.contracts import ReadAssembly
from specmate.operations import Context
from specmate.shared_scene.drawing_contracts import ReadDrawing, ReadDrawingScene
from specmate.shared_scene.drawing_operations import (
    drawing_record,
    package_bytes,
    read_drawing,
    read_drawing_scene,
)
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


@router.get("/drawings/{drawing_id}")
def inspect_drawing(request, drawing_id: UUID, project_id: UUID | None = None):
    return read_drawing(
        Context(user=request.user, via="api", request_id="drawing-read"),
        ReadDrawing(drawing_id=drawing_id, project_id=project_id),
    )


@router.get("/drawings/{drawing_id}/{part}")
def drawing_download(request, drawing_id: UUID, part: str, project_id: UUID | None = None):
    drawing = drawing_record(request.user, drawing_id, project_id)
    if part == "svg":
        raw, media_type, filename = bytes(drawing.svg), "image/svg+xml", "drawing.svg"
    elif part == "manifest":
        raw, media_type, filename = bytes(drawing.manifest), "application/json", "manifest.json"
    elif part == "package":
        raw, media_type, filename = (
            package_bytes(drawing),
            "application/zip",
            "scene-inspection.zip",
        )
    else:
        from specmate.operations import NotFound

        raise NotFound("Drawing output unavailable.")
    response = HttpResponse(raw, content_type=media_type)
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Cache-Control"] = "no-store, private"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response["X-Content-SHA256"] = hashlib.sha256(raw).hexdigest()
    return response


@router.get("/drawing-scenes/{snapshot_id}")
def inspect_drawing_scene(request, snapshot_id: UUID, project_id: UUID):
    return read_drawing_scene(
        Context(user=request.user, via="api", request_id="drawing-scene-read"),
        ReadDrawingScene(project_id=project_id, snapshot_id=snapshot_id),
    )
