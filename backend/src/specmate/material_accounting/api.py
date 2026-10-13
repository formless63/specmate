from uuid import UUID

from ninja import Router

from specmate.design.operations import draft_state
from specmate.material_accounting.contracts import MaterialPlan
from specmate.material_accounting.operations import plan_draft
from specmate.material_accounting.queries import closure, inspect_revision
from specmate.operations import Context

router = Router(tags=["material-accounting"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = plan_draft(Context(user=request.user, via="api", request_id="read"), draft_id)
    return {"definition_id": str(value.definition_id), **draft_state(value)}


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID):
    return inspect_revision(request.user, revision_id)


@router.post("/authority")
def authority(request, payload: MaterialPlan):
    closure(request.user, {"material_plan": payload.model_dump(mode="json")}, authority_only=True)
    return {"authorized": True}
