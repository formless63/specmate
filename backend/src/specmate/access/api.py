"""Workspace and project reads; all mutations use the shared operation adapter."""

from uuid import UUID

from ninja import Router

from specmate.access.workspaces import is_installation_owner
from specmate.operations import Context, execute

router = Router(tags=["workspace access"])


@router.get("/account-policy")
def account_policy(request):
    return {"can_create_local_accounts": is_installation_owner(request.user)}


@router.get("/workspace")
def workspace_access(request, workspace_id: UUID | None = None):
    result = execute(
        "workspace.access",
        Context(user=request.user, via="api", request_id="workspace-access-read"),
        {"workspace_id": workspace_id},
    )
    return result.result


@router.get("/projects/{project_id}")
def project_detail(request, project_id: UUID, include_removed: bool = False):
    result = execute(
        "project.references",
        Context(user=request.user, via="api", request_id="project-read"),
        {"project_id": project_id, "include_removed": include_removed},
    )
    return result.result
