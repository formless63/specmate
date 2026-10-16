from uuid import UUID

from django.http import JsonResponse
from ninja import Query, Router

from specmate.access.permissions import Perm
from specmate.cables.connections import ConnectionsQuery, connections
from specmate.cables.contracts import ProposeCable
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
def revision(request, revision_id: UUID, quantity: int = 1):
    return inspect_revision(request.user, revision_id, quantity)


@router.get("/length-impact")
def lengths(request, before_revision_id: UUID, after_revision_id: UUID):
    return length_impact(request.user, before_revision_id, after_revision_id)


@router.get("/revisions/{revision_id}/intent-check")
def revision_intent_check(request, revision_id: UUID, intent_revision_id: UUID | None = None):
    """The cable checked against its (or the named) intent; read-only."""
    from specmate.cables.intent_check import check_revision

    return check_revision(request.user, revision_id, intent_revision_id)[1]


@router.get("/drafts/{draft_id}/intent-check")
def draft_intent_check(request, draft_id: UUID, intent_revision_id: UUID | None = None):
    """The saved cable draft checked against its (or the named) intent; read-only."""
    from specmate.cables.intent_check import check

    value = cable_draft(
        Context(user=request.user, via="api", request_id="read"), draft_id, Perm.WORKSPACE_READ
    )
    result = check(request.user, value.content, "cable", intent_revision_id)
    return {"cable_revision_id": None, "draft_id": str(value.id), **result}


@router.post("/propose")
def propose(request, payload: ProposeCable):
    """Proposed wiring from an intent, with its check result (read-only, never stored)."""
    from specmate.cables.propose import propose_cable

    draft = (
        cable_draft(
            Context(user=request.user, via="api", request_id="read"),
            payload.draft_id,
            Perm.WORKSPACE_READ,
        )
        if payload.draft_id
        else None
    )
    return propose_cable(request.user, payload, draft)


@router.get("/connections")
def connecting_ports(request, payload: Query[ConnectionsQuery]):
    return JsonResponse(
        connections(request.user, payload), headers={"Cache-Control": "private, no-store"}
    )
