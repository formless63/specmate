"""Project-scoped stock reads; no connector/device configuration prerequisite."""

from uuid import UUID

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Draft
from specmate.design.operations import draft_state, scoped_draft
from specmate.operations import Context, NotFound


def list_stocks(user, project_id: UUID) -> list[dict]:
    workspace = authorize(user, project_id, Perm.WORKSPACE_READ)
    return [
        {"definition_id": str(d.definition_id), "name": d.definition.name, **draft_state(d)}
        for d in Draft.objects.select_related("definition")
        .filter(definition__workspace=workspace, definition__kind="wire_stock")
        .order_by("definition__created_at", "id")
    ]


def get_stock(user, draft_id: UUID) -> dict:
    draft = scoped_draft(
        Context(user=user, via="internal", request_id="stock-read"), draft_id, Perm.WORKSPACE_READ
    )
    if draft.definition.kind != "wire_stock":
        raise NotFound("Stock draft not found.")
    return {
        "definition_id": str(draft.definition_id),
        "name": draft.definition.name,
        **draft_state(draft),
    }
