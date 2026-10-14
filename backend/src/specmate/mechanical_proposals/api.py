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
    list_proposals,
    read,
    read_retained,
)
from specmate.operations import Context

router = Router(tags=["mechanical proposals"])


def context(request, name):
    return Context(user=request.user, via="api", request_id=name)


@router.get("/projects/{project_id}/boards")
def boards(request, project_id: UUID):
    return board_choices(context(request, "proposal-boards"), ListProposals(project_id=project_id))


@router.get("/projects/{project_id}/boards/{interpretation_id}")
def board(request, project_id: UUID, interpretation_id: UUID):
    return board_inputs(
        context(request, "proposal-board"),
        BoardInputs(project_id=project_id, interpretation_id=interpretation_id),
    )


@router.get("/projects/{project_id}/drafts")
def drafts(request, project_id: UUID):
    return list_proposals(context(request, "proposal-list"), ListProposals(project_id=project_id))


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    return read(context(request, "proposal-read"), DraftRef(draft_id=draft_id))


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID, project_id: UUID | None = None):
    return read_retained(
        context(request, "proposal-retained"),
        RetainedRef(revision_id=revision_id, project_id=project_id),
    )
