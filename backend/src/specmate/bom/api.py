from uuid import UUID

from ninja import Router

from specmate.access.permissions import Perm
from specmate.bom.contracts import Purpose
from specmate.bom.operations import bom_draft
from specmate.bom.queries import inspect_revision
from specmate.design.operations import draft_state
from specmate.operations import Context

router = Router(tags=["bom"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = bom_draft(
        Context(user=request.user, via="api", request_id="read"), draft_id, Perm.PROJECT_READ
    )
    return {"definition_id": str(value.definition_id), **draft_state(value)}


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID, purpose: Purpose = "procurement"):
    return inspect_revision(request.user, revision_id, purpose)
