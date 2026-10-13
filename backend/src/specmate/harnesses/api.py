from uuid import UUID

from ninja import Router

from specmate.access.permissions import Perm
from specmate.catalog_matching.queries import current_actor
from specmate.design.operations import draft_state
from specmate.harnesses.contracts import Harness
from specmate.harnesses.operations import harness_draft
from specmate.harnesses.queries import authorize_content, inspect_revision
from specmate.operations import Context

router = Router(tags=["harnesss"])


@router.post("/authority")
def authority(request, payload: Harness):
    authorize_content(
        current_actor(request.user),
        {"harness": payload.model_dump(mode="json")},
        authority_only=True,
    )
    return {"authorized": True}


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = harness_draft(
        Context(user=request.user, via="api", request_id="read"), draft_id, Perm.PROJECT_READ
    )
    return {
        "definition_id": str(value.definition_id),
        "kind": value.definition.kind,
        **draft_state(value),
    }


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID, quantity: int = 1):
    return inspect_revision(request.user, revision_id, quantity)
