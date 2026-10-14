from uuid import UUID

from django.http import JsonResponse
from ninja import Router

from specmate.operations import Context, execute

router = Router(tags=["diagnostics"])


@router.get("/workspaces/{workspace_id}/status")
def workspace_status(request, workspace_id: UUID):
    """Scoped, permission-checked state for the shell; never cached or shared."""
    result = execute(
        "diagnostics.workspace_status",
        Context(user=request.user, via="api", request_id="workspace-status", request=request),
        {"workspace_id": workspace_id},
    )
    response = JsonResponse(result.result)
    response["Cache-Control"] = "private, no-store"
    return response
