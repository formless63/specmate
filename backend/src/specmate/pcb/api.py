from uuid import UUID

from django.http import FileResponse
from django.utils.http import content_disposition_header
from ninja import Router

from specmate.access.permissions import Perm, authorize
from specmate.operations import Context, NotFound
from specmate.pcb.models import PcbIntake
from specmate.pcb.operations import IntakeRef, get_intake, intake_for
from specmate.sources import blobstore

router = Router(tags=["pcb"])


@router.get("/projects/{project_id}/intakes")
def list_intakes(request, project_id: UUID):
    authorize(request.user, project_id, Perm.PROJECT_READ)
    return [
        {
            "intake_id": str(i.id),
            "board_path": i.board_path,
            "source_revision_id": str(i.source_revision_id),
        }
        for i in PcbIntake.objects.filter(source_revision__bundle__project_id=project_id).order_by(
            "created_at"
        )
    ]


@router.get("/intakes/{intake_id}")
def read_intake(request, intake_id: UUID):
    return get_intake(
        Context(user=request.user, via="api", request_id="read-pcb"), IntakeRef(intake_id=intake_id)
    )


@router.get("/intakes/{intake_id}/original")
def read_original(request, intake_id: UUID, path: str):
    intake = intake_for(
        Context(user=request.user, via="api", request_id="read-original"), intake_id
    )
    file = intake.source_revision.files.select_related("blob").filter(path=path).first()
    if file is None:
        raise NotFound("Preserved file not found.")
    response = FileResponse(
        blobstore.open_blob(file.blob.sha256), content_type="application/octet-stream"
    )
    response["Content-Disposition"] = content_disposition_header(True, file.path.rsplit("/", 1)[-1])
    response["X-Content-Type-Options"] = "nosniff"
    response["Digest"] = f"sha-256={file.blob.sha256}"
    return response
