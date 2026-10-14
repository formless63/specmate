"""Read adapters; mutations use the shared operation envelope."""

from uuid import UUID

from ninja import Router

from specmate.mechanical_proposals.contracts import (
    BoardInputs,
    DraftRef,
    ListProposals,
    RetainedRef,
)
from specmate.mechanical_proposals.operations import (
    board_choices,
    board_inputs,
    draft_targets,
    list_proposals,
    read,
    read_retained,
)
from specmate.operations import Context

router = Router(tags=["mechanical proposals"])


def context(request, name):
    return Context(user=request.user, via="api", request_id=name)


@router.get("/workspaces/{workspace_id}/boards")
def boards(request, workspace_id: UUID):
    return board_choices(
        context(request, "proposal-boards"), ListProposals(workspace_id=workspace_id)
    )


@router.get("/workspaces/{workspace_id}/boards/{interpretation_id}")
def board(request, workspace_id: UUID, interpretation_id: UUID):
    return board_inputs(
        context(request, "proposal-board"),
        BoardInputs(workspace_id=workspace_id, interpretation_id=interpretation_id),
    )


@router.get("/workspaces/{workspace_id}/drafts")
def drafts(request, workspace_id: UUID):
    return list_proposals(
        context(request, "proposal-list"), ListProposals(workspace_id=workspace_id)
    )


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    return read(context(request, "proposal-read"), DraftRef(draft_id=draft_id))


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID, workspace_id: UUID | None = None):
    return read_retained(
        context(request, "proposal-retained"),
        RetainedRef(revision_id=revision_id, workspace_id=workspace_id),
    )


@router.get("/workspaces/{workspace_id}/draft-targets")
def targets(request, workspace_id: UUID):
    return draft_targets(
        context(request, "proposal-targets"), ListProposals(workspace_id=workspace_id)
    )
