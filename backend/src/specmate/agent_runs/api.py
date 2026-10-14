"""HTTP reads for agent runs; answers come from the shared read operations.
Mutations use the generic operation envelope (POST /api/v0/operations)."""

from uuid import UUID

from django.http import JsonResponse
from ninja import Router

from specmate.operations import Context, execute

router = Router(tags=["agent-runs"])


def _read(request, name: str, payload: dict) -> JsonResponse:
    result = execute(
        name,
        Context(user=request.user, via="api", request_id="agent-run-read", request=request),
        payload,
    )
    response = JsonResponse(result.result)
    response["Cache-Control"] = "private, no-store"
    return response


@router.get("")
def list_runs(
    request,
    workspace_id: UUID,
    project_id: UUID | None = None,
    status: str | None = None,
    limit: int = 50,
):
    payload = {"workspace_id": workspace_id, "project_id": project_id, "limit": limit}
    if status:
        payload["status"] = status
    return _read(request, "agent_run.list", payload)


@router.get("/{run_id}")
def read_run(request, run_id: UUID):
    return _read(request, "agent_run.read", {"run_id": run_id})


@router.get("/{run_id}/review-package")
def review_package(request, run_id: UUID):
    return _read(request, "agent_run.review_package", {"run_id": run_id})
