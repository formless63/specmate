from uuid import UUID

from ninja import Router

from specmate.design.operations import draft_state
from specmate.end_preparation.application import apply_profile
from specmate.end_preparation.contracts import ApplyProfile, EndPreparationProfile
from specmate.end_preparation.operations import profile_draft
from specmate.end_preparation.queries import closure, inspect_profile
from specmate.operations import Context

router = Router(tags=["end-preparation"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = profile_draft(Context(user=request.user, via="api", request_id="read"), draft_id)
    return {"definition_id": str(value.definition_id), **draft_state(value)}


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID):
    return inspect_profile(request.user, revision_id)


@router.post("/apply")
def calculate(request, payload: ApplyProfile):
    return apply_profile(request.user, payload)


@router.post("/authority")
def authority(request, payload: EndPreparationProfile):
    closure(
        request.user,
        {"end_preparation_profile": payload.model_dump(mode="json")},
        authority_only=True,
    )
    return {"authorized": True}
