from uuid import UUID

from ninja import Router

from specmate.workshop_profiles.queries import (
    get_profile,
    list_profile_revisions,
    list_profiles,
    revision_result,
)

router = Router(tags=["workshop profiles"])


@router.get("/workshop-profiles")
def profiles(request, workspace_id: UUID | None = None, project_id: UUID | None = None):
    return list_profiles(request.user, workspace_id, project_id)


@router.get("/workshop-profiles/{draft_id}")
def profile(request, draft_id: UUID):
    return get_profile(request.user, draft_id)


@router.get("/workshop-profile-definitions/{definition_id}/revisions")
def profile_revisions(request, definition_id: UUID):
    return list_profile_revisions(request.user, definition_id)


@router.get("/workshop-profile-revisions/{revision_id}")
def profile_revision(request, revision_id: UUID):
    return revision_result(request.user, revision_id)
