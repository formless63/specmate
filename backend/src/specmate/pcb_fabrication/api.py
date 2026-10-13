from uuid import UUID

from django.http import FileResponse
from django.utils.http import content_disposition_header
from ninja import Router

from specmate.catalog_matching.queries import current_actor
from specmate.operations import Context, NotFound
from specmate.pcb_fabrication.operations import (
    BuildRef,
    options,
    read,
    scoped_build,
    validate_outputs,
)
from specmate.sources import blobstore

router = Router(tags=["pcb-fabrication"])


def context(request):
    return Context(user=current_actor(request.user), via="api", request_id="read-pcb-fabrication")


@router.get("/intakes/{intake_id}")
def read_options(request, intake_id: UUID):
    return options(context(request), intake_id)


@router.get("/intakes/{intake_id}/builds/{build_id}")
def read_build(request, intake_id: UUID, build_id: UUID):
    return read(context(request), BuildRef(intake_id=intake_id, build_id=build_id))


@router.get("/intakes/{intake_id}/builds/{build_id}/outputs/{output_id}")
def download_output(request, intake_id: UUID, build_id: UUID, output_id: UUID):
    _, file, build = scoped_build(context(request), intake_id, build_id)
    _, outputs = validate_outputs(file, build)
    output = next((o for o in outputs.values() if o.id == output_id), None)
    if output is None:
        raise NotFound("Registered fabrication output unavailable.")
    response = FileResponse(
        blobstore.open_blob(output.sha256), content_type="application/octet-stream"
    )
    response["Content-Disposition"] = content_disposition_header(True, output.path)
    response["X-Content-Type-Options"] = "nosniff"
    response["Digest"] = f"sha-256={output.sha256}"
    return response
