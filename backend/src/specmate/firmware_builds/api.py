from uuid import UUID

from django.http import FileResponse
from django.utils.http import content_disposition_header
from ninja import Router
from pydantic import ValidationError

from specmate.catalog_matching.queries import current_actor
from specmate.firmware_builds.contracts import CompileRef, FirmwareRef
from specmate.firmware_builds.operations import options, read, scoped_build, validate_outputs
from specmate.operations import Context, NotFound, ValidationFailed
from specmate.sources import blobstore

router = Router(tags=["firmware-builds"])


def context(request):
    return Context(user=current_actor(request.user), via="api", request_id="read-firmware-compile")


def reference(firmware_id, assembly_snapshot_id=None, path=""):
    try:
        return FirmwareRef(
            firmware_revision_id=firmware_id,
            assembly_snapshot_id=assembly_snapshot_id,
            path=path.split("/") if path else [],
        )
    except ValidationError:
        raise ValidationFailed(
            "Supply an exact frozen occurrence snapshot and portable path together."
        ) from None


@router.get("/firmware/{firmware_id}")
def read_options(
    request, firmware_id: UUID, assembly_snapshot_id: UUID | None = None, path: str = ""
):
    return options(context(request), reference(firmware_id, assembly_snapshot_id, path))


@router.get("/firmware/{firmware_id}/builds/{build_id}")
def read_build(
    request,
    firmware_id: UUID,
    build_id: UUID,
    assembly_snapshot_id: UUID | None = None,
    path: str = "",
):
    ref = reference(firmware_id, assembly_snapshot_id, path)
    return read(context(request), CompileRef(**ref.model_dump(), build_id=build_id))


@router.get("/firmware/{firmware_id}/builds/{build_id}/outputs/{output_id}")
def download_output(
    request,
    firmware_id: UUID,
    build_id: UUID,
    output_id: UUID,
    assembly_snapshot_id: UUID | None = None,
    path: str = "",
):
    ref = reference(firmware_id, assembly_snapshot_id, path)
    _, spec, build = scoped_build(
        context(request), CompileRef(**ref.model_dump(), build_id=build_id)
    )
    _, outputs = validate_outputs(spec, build)
    output = next((o for o in outputs.values() if o.id == output_id), None)
    if output is None:
        raise NotFound("Registered firmware output unavailable.")
    response = FileResponse(
        blobstore.open_blob(output.sha256), content_type="application/octet-stream"
    )
    response["Content-Disposition"] = content_disposition_header(True, output.path)
    response["X-Content-Type-Options"] = "nosniff"
    response["Digest"] = f"sha-256={output.sha256}"
    return response
