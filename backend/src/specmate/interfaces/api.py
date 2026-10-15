from uuid import UUID

from django.http import JsonResponse
from ninja import Query, Router
from pydantic import ValidationError

from specmate.access.permissions import Perm
from specmate.design.operations import draft_state
from specmate.interfaces.board_contracts import ProposeBoard, TraceBoard
from specmate.interfaces.boards import propose_board, trace_board
from specmate.interfaces.conventions import stock_conventions
from specmate.interfaces.end_assembly_contracts import ResolveEnd
from specmate.interfaces.intent_contracts import ProposeIntent
from specmate.interfaces.operations import interface_draft
from specmate.interfaces.queries import (
    end_expectations,
    inspect_revision,
    propose_intent,
    resolve_end,
    trace,
)
from specmate.interfaces.related import RelatedQuery, connector_relations
from specmate.operations import Context, ValidationFailed

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


@router.get("/revisions/{revision_id}/related")
def related(request, revision_id: UUID, query: Query[RelatedQuery]):
    return JsonResponse(
        connector_relations(request.user, revision_id, query),
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/revisions/{revision_id}/trace")
def declared_trace(request, revision_id: UUID, contact_id: str):
    return trace(request.user, revision_id, contact_id)


@router.get("/revisions/{revision_id}/end")
def cable_end(request, revision_id: UUID):
    """Per-contact expectations of a device port or a bare pinout variant."""
    return end_expectations(request.user, revision_id)


@router.get("/revisions/{revision_id}/board-trace")
def board_trace(
    request,
    revision_id: UUID,
    from_terminal_id: str,
    to_terminal_id: str,
    query: str = "dc_continuity",
    copper_assumption: str = "unspecified",
    frequency_hz: str | None = None,
    condition: list[str] = Query(None),  # noqa: B008
):
    """Declared board paths between two terminals; ``condition`` items read ``key=state``."""
    assignments = []
    for item in condition or []:
        key, _, state = item.partition("=")
        assignments.append({"condition_id": key, "state": state})
    payload = {
        "revision_id": revision_id,
        "from_terminal_id": from_terminal_id,
        "to_terminal_id": to_terminal_id,
        "query": query,
        "copper_assumption": copper_assumption,
        "condition_assignments": assignments,
    }
    if frequency_hz is not None:
        payload["frequency_hz"] = frequency_hz
    return trace_board(request.user, parse(TraceBoard, payload))


@router.get("/boards/propose")
def board_proposal(
    request,
    population_revision_id: UUID,
    component_id: list[UUID] = Query(None),  # noqa: B008
):
    """Terminals and paths proposed from a frozen PCB population; nothing is stored."""
    return propose_board(
        request.user,
        parse(
            ProposeBoard,
            {"population_revision_id": population_revision_id, "component_ids": component_id},
        ),
    )


def parse(model, payload):
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise ValidationFailed("Invalid board query.") from exc


@router.get("/stock-revisions/{revision_id}/conventions")
def conventions_for_stock(request, revision_id: UUID):
    """Frozen conductor conventions that apply to one frozen wire stock revision."""
    return stock_conventions(request.user, revision_id)


@router.post("/end-stacks/resolve")
def end_stack(request, payload: ResolveEnd):
    """One end stack's layers, labeled terminals and joins (read-only)."""
    return resolve_end(request.user, payload)


@router.get("/intents/propose")
def intent_proposal(request, from_revision_id: UUID, to_revision_id: UUID):
    """Proposed cable intent rows between two exact ends (read-only)."""
    payload = {"from_revision_id": from_revision_id, "to_revision_id": to_revision_id}
    return propose_intent(request.user, parse(ProposeIntent, payload))
