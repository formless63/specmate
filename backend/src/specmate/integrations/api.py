from uuid import UUID

from ninja import Router

from specmate.integrations import queries

router = Router(tags=["integrations"])


@router.get("/workspaces/{workspace_id}")
def integrations(request, workspace_id: UUID):
    return queries.list_integrations(request.user, workspace_id)


@router.get("/{integration_id}/history")
def history(request, integration_id: UUID, offset: int = 0, limit: int = 50):
    return queries.list_runs(
        request.user, integration_id, offset=max(offset, 0), limit=min(max(limit, 1), 100)
    )


@router.get("/workspaces/{workspace_id}/revisions/{revision_id}/observations")
def observations(request, workspace_id: UUID, revision_id: UUID, kind: str | None = None):
    return queries.list_observations(request.user, workspace_id, revision_id, kind=kind)
