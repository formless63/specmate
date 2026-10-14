from uuid import UUID

from ninja import Router

from specmate.access.permissions import Perm
from specmate.cables.operations import cable_draft
from specmate.cables.queries import inspect_revision, length_impact
from specmate.design.operations import draft_state
from specmate.operations import Context

router = Router(tags=["cables"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = cable_draft(
        Context(user=request.user, via="api", request_id="read"), draft_id, Perm.WORKSPACE_READ
    )
    return {
        "definition_id": str(value.definition_id),
        "kind": value.definition.kind,
        **draft_state(value),
    }


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID):
    return inspect_revision(request.user, revision_id)


@router.get("/length-impact")
def lengths(request, before_revision_id: UUID, after_revision_id: UUID):
    return length_impact(request.user, before_revision_id, after_revision_id)
