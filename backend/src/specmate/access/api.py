"""Scoped project access reads; all mutations use the shared operation adapter."""

from uuid import UUID

from ninja import Router

from specmate.access.projects import is_installation_owner
from specmate.operations import Context, execute

router = Router(tags=["project access"])


@router.get("/account-policy")
def account_policy(request):
    return {"can_create_local_accounts": is_installation_owner(request.user)}


@router.get("/projects/{project_id}")
def project_access(request, project_id: UUID):
    result = execute(
        "project.access",
        Context(user=request.user, via="api", request_id="project-access-read"),
        {"project_id": project_id},
    )
    return result.result
