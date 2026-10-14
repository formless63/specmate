"""HTTP adapter for discovery; the answer is computed by the shared operation."""

from uuid import UUID

from ninja import Router

from specmate.operations import Context, execute

router = Router(tags=["discovery"])


@router.get("/capabilities")
def capabilities(request, project_id: UUID | None = None, include_schemas: bool = False):
    result = execute(
        "discovery.capabilities",
        Context(user=request.user, via="api", request_id="discovery-read", request=request),
        {"project_id": project_id, "include_schemas": include_schemas},
    )
    return result.result
