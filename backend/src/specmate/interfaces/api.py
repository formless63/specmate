from uuid import UUID

from ninja import Router

from specmate.access.permissions import Perm
from specmate.design.operations import draft_state
from specmate.interfaces.operations import interface_draft
from specmate.interfaces.queries import inspect_revision, trace
from specmate.operations import Context

router = Router(tags=["interfaces"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = interface_draft(
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


@router.get("/revisions/{revision_id}/trace")
def declared_trace(request, revision_id: UUID, contact_id: str):
    return trace(request.user, revision_id, contact_id)
