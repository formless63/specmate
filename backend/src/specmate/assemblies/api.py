from uuid import UUID

from ninja import Router

from specmate.access.permissions import Perm
from specmate.assemblies.placement import PlacementInputs, inspect_inputs
from specmate.assemblies.queries import authorize_content, read_assembly
from specmate.design.operations import draft_state, scoped_draft
from specmate.operations import Context, ValidationFailed

router = Router(tags=["assemblies"])


@router.get("/drafts/{draft_id}/placement-inputs")
def inspect_placement_inputs(request, draft_id: UUID):
    return inspect_inputs(
        Context(user=request.user, via="api", request_id="placement-read"),
        PlacementInputs(draft_id=draft_id),
    )


@router.get("/snapshots/{snapshot_id}")
def inspect_snapshot(request, snapshot_id: UUID):
    return read_assembly(request.user, snapshot_id)


@router.get("/drafts/{draft_id}")
def inspect_draft(request, draft_id: UUID):
    draft = scoped_draft(
        Context(user=request.user, via="api", request_id="read"), draft_id, Perm.WORKSPACE_READ
    )
    if draft.definition.kind != "assembly":
        raise ValidationFailed("Draft is not an assembly.")
    authorize_content(request.user, draft.content, draft.definition.workspace_id)
    return {"definition_id": str(draft.definition_id), **draft_state(draft)}
