from uuid import UUID

from django.http import JsonResponse
from ninja import Router

from specmate.operations import Context, execute

router = Router(tags=["diagnostics"])


@router.get("/projects/{project_id}/status")
def project_status(request, project_id: UUID):
    """Scoped, permission-checked state for the shell; never cached or shared."""
    result = execute(
        "diagnostics.project_status",
        Context(user=request.user, via="api", request_id="project-status", request=request),
        {"project_id": project_id},
    )
    response = JsonResponse(result.result)
    response["Cache-Control"] = "private, no-store"
    return response
