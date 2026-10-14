"""Durable internal inspection outputs with fresh authority before every disclosure."""

import hashlib
import io
import json
import zipfile
from uuid import UUID

from specmate.access.permissions import Perm, authorize, workspace_for_project
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Snapshot
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope
from specmate.shared_scene.drawing_contracts import CreateDrawing, ReadDrawing, ReadDrawingScene
from specmate.shared_scene.drawing_render import render_drawing
from specmate.shared_scene.models import SceneDrawing
from specmate.shared_scene.projection import read_scene


def _scope_workspace(scope_id):
    """TRANSITIONAL: a payload project id selects its workspace (a workspace id passes)."""
    return str(workspace_for_project(scope_id) or scope_id)


def authorized_scene(user, snapshot_id, project_id=None):
    user = current_actor(user)
    snapshot = Snapshot.objects.select_related("definition").filter(id=snapshot_id).first()
    if snapshot is None:
        raise NotFound("Scene unavailable.")
    authorize(user, snapshot.definition.workspace_id, Perm.WORKSPACE_READ)
    if project_id is not None and str(snapshot.definition.workspace_id) != _scope_workspace(
        project_id
    ):
        raise NotFound("Scene unavailable in this workspace.")
    return snapshot, read_scene(user, snapshot_id)


def drawing_record(user, drawing_id, project_id=None):
    user = current_actor(user)
    query = SceneDrawing.objects.filter(id=drawing_id)
    if project_id is not None:
        query = query.filter(workspace_id=_scope_workspace(project_id))
    drawing = query.first()
    if drawing is None:
        raise NotFound("Drawing unavailable.")
    authorize(user, drawing.workspace_id, Perm.WORKSPACE_READ)
    authorized_scene(user, drawing.snapshot_id, drawing.workspace_id)
    if hashlib.sha256(bytes(drawing.svg)).hexdigest() != drawing.svg_sha256 or (
        hashlib.sha256(bytes(drawing.manifest)).hexdigest() != drawing.manifest_sha256
    ):
        raise ValidationFailed("Drawing integrity check failed.")
    return drawing


def metadata(drawing):
    # Historic guidance belongs to these retained bytes, not the current renderer.
    # Callers obtain the row only after fresh authority and stored hash checks.
    manifest = json.loads(bytes(drawing.manifest))
    return {
        "drawing_id": str(drawing.id),
        "workspace_id": str(drawing.workspace_id),
        "snapshot_id": str(drawing.snapshot_id),
        "renderer_version": drawing.renderer_version,
        "purpose": drawing.purpose,
        "options": drawing.options,
        "svg_sha256": drawing.svg_sha256,
        "manifest_sha256": drawing.manifest_sha256,
        "svg_bytes": len(drawing.svg),
        "manifest_bytes": len(drawing.manifest),
        "created_at": drawing.created_at.isoformat(),
        "limitations": manifest["limitations"],
        "qualification": manifest["qualification"],
    }


def drawing_scope(ctx, payload):
    snapshot, _ = authorized_scene(ctx.user, payload.snapshot_id, payload.project_id)
    scope = workspace_scope(ctx, snapshot.definition.workspace_id)
    # Protect historic receipts before even the generic mismatched-fingerprint response.
    prior = (
        IdempotencyRecord.objects.select_for_update()
        .filter(
            actor=ctx.user,
            operation="shared_scene.create_drawing",
            key=ctx.idempotency_key,
            scope=scope,
        )
        .first()
    )
    if prior:
        drawing_record(ctx.user, UUID(prior.result["drawing_id"]))
    return scope


def drawing_replay(ctx, payload, stored):
    authorized_scene(ctx.user, payload.snapshot_id, payload.project_id)
    drawing_record(ctx.user, UUID(stored["drawing_id"]))


@operation(
    "shared_scene.create_drawing",
    CreateDrawing,
    summary="Create a durable internal inspection SVG/manifest, without engineering state edits.",
    idempotency_scope=drawing_scope,
    authorize_replay=drawing_replay,
)
def create_drawing(ctx: Context, payload: CreateDrawing):
    if not ctx.idempotency_key:
        raise ValidationFailed("Drawing generation requires an idempotency key.")
    snapshot, scene = authorized_scene(ctx.user, payload.snapshot_id, payload.project_id)
    svg, manifest = render_drawing(scene, payload.options, payload.renderer_version)
    drawing = SceneDrawing.objects.create(
        workspace_id=snapshot.definition.workspace_id,
        snapshot=snapshot,
        renderer_version=payload.renderer_version,
        purpose=payload.purpose,
        options=payload.options.model_dump(mode="json"),
        svg=svg,
        manifest=manifest,
        svg_sha256=hashlib.sha256(svg).hexdigest(),
        manifest_sha256=hashlib.sha256(manifest).hexdigest(),
        created_by=ctx.user,
        request_id=ctx.request_id,
    )
    # A last current closure check also makes a mid-render denial roll back the derived row.
    drawing_record(ctx.user, drawing.id)
    return metadata(drawing)


@operation(
    "shared_scene.read_drawing",
    ReadDrawing,
    summary="Inspect a retained drawing with current actor/source authority.",
    supports_idempotency=False,
)
def read_drawing(ctx: Context, payload: ReadDrawing):
    drawing = drawing_record(ctx.user, payload.drawing_id, payload.project_id)
    return {**metadata(drawing), "manifest": json.loads(bytes(drawing.manifest))}


def package_bytes(drawing):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, content in [
            ("drawing.svg", bytes(drawing.svg)),
            ("manifest.json", bytes(drawing.manifest)),
        ]:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    return output.getvalue()


@operation(
    "shared_scene.read_drawing_scene",
    ReadDrawingScene,
    summary="Read a currently authorized exact scene within the selected drawing project.",
    supports_idempotency=False,
)
def read_drawing_scene(ctx: Context, payload: ReadDrawingScene):
    _, scene = authorized_scene(ctx.user, payload.snapshot_id, payload.project_id)
    return scene
