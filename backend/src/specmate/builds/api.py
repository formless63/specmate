"""Thin runner transport; bearer credentials never inherit browser/session authority."""

from uuid import UUID

from django.http import FileResponse
from ninja import File, Form, Router, Schema
from ninja.files import UploadedFile
from ninja.security import HttpBearer, django_auth

from specmate.builds.operations import authenticate_runner
from specmate.operations import Context, execute
from specmate.sources import blobstore


class RunnerAuth(HttpBearer):
    def authenticate(self, request, token):
        return authenticate_runner(token)


router = Router(auth=RunnerAuth(), tags=["runner"])
artifacts_router = Router(auth=django_auth, tags=["builds"])


class Request(Schema):
    request_id: str


class LeaseRequest(Request):
    fencing_token: UUID


class ReconcileRequest(LeaseRequest):
    container_id: str
    observed: str


class CompleteRequest(LeaseRequest):
    outcome: str
    exit_code: int | None = None
    outputs: list[dict] = []
    message: str = ""
    image_id: str | None = None


def _execute(request, name, request_id, payload, attachments=None):
    return execute(
        name,
        Context(user=request.auth, via="api", request_id=request_id, attachments=attachments or {}),
        payload,
    )


@router.post("/leases")
def lease(request, body: Request):
    return _execute(request, "runner.lease", body.request_id, {})


@router.post("/stages/{stage_id}/heartbeat")
def heartbeat(request, stage_id: UUID, body: LeaseRequest):
    return _execute(
        request,
        "runner.heartbeat",
        body.request_id,
        {"stage_id": stage_id, "fencing_token": body.fencing_token},
    )


@router.post("/stages/{stage_id}/reconcile")
def reconcile(request, stage_id: UUID, body: ReconcileRequest):
    return _execute(
        request,
        "runner.reconcile",
        body.request_id,
        {"stage_id": stage_id, **body.model_dump(exclude={"request_id"})},
    )


@router.post("/stages/{stage_id}/complete")
def complete(request, stage_id: UUID, body: CompleteRequest):
    return _execute(
        request,
        "runner.complete",
        body.request_id,
        {"stage_id": stage_id, **body.model_dump(exclude={"request_id"})},
    )


@router.get("/stages/{stage_id}/inputs/{sha256}")
def download_input(request, stage_id: UUID, sha256: str, fencing_token: UUID):
    result = _execute(
        request,
        "runner.input",
        "download-input",
        {"stage_id": stage_id, "sha256": sha256, "fencing_token": fencing_token},
    )
    return FileResponse(
        blobstore.open_blob(result.result["sha256"]), content_type=result.result["media_type"]
    )


@router.post("/stages/{stage_id}/outputs")
def output(
    request,
    stage_id: UUID,
    request_id: Form[str],
    fencing_token: Form[UUID],
    path: Form[str],
    sha256: Form[str],
    size: Form[int],
    media_type: Form[str],
    rights: Form[str],
    source_revision_id: Form[UUID],
    content: File[UploadedFile],
):
    return _execute(
        request,
        "runner.output",
        request_id,
        {
            "stage_id": stage_id,
            "fencing_token": fencing_token,
            "path": path,
            "sha256": sha256,
            "size": size,
            "media_type": media_type,
            "rights": rights,
            "source_revision_id": source_revision_id,
        },
        attachments={"content": content},
    )


@artifacts_router.get("/{build_id}/outputs/{output_id}")
def download_output(request, build_id: UUID, output_id: UUID):
    result = execute(
        "build.output",
        Context(user=request.user, via="api", request_id="download-output"),
        {"build_id": build_id, "output_id": output_id},
    )
    return FileResponse(
        blobstore.open_blob(result.result["sha256"]),
        content_type="application/octet-stream",
        as_attachment=True,
        filename=result.result["path"].rsplit("/", 1)[-1],
    )


@artifacts_router.get("/reuse/{reuse_id}/outputs/{output_id}")
def download_reused_output(request, reuse_id: UUID, output_id: UUID):
    result = execute(
        "build.reuse_output",
        Context(user=request.user, via="api", request_id="download-reused-output"),
        {"reuse_id": reuse_id, "output_id": output_id},
    )
    return FileResponse(
        blobstore.open_blob(result.result["sha256"]),
        content_type="application/octet-stream",
        as_attachment=True,
        filename=result.result["path"].rsplit("/", 1)[-1],
    )
