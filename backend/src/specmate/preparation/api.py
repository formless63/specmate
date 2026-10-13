from uuid import UUID

from ninja import Router

from specmate.design.operations import draft_state
from specmate.operations import Context
from specmate.preparation.calculation import compute
from specmate.preparation.contracts import ComputeCuts, PreparationProfile
from specmate.preparation.operations import profile_draft
from specmate.preparation.queries import closure, inspect_profile

router = Router(tags=["preparation"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = profile_draft(Context(user=request.user, via="api", request_id="read"), draft_id)
    return {"definition_id": str(value.definition_id), **draft_state(value)}


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID):
    return inspect_profile(request.user, revision_id)


@router.post("/compute")
def calculate(request, payload: ComputeCuts):
    return compute(request.user, payload)


@router.post("/authority")
def authority(request, payload: PreparationProfile):
    closure(
        request.user, {"preparation_profile": payload.model_dump(mode="json")}, authority_only=True
    )
    return {"authorized": True}
