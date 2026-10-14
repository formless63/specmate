"""Workspace library stock reads; no connector/device configuration prerequisite."""

from uuid import UUID

from specmate.access.permissions import Perm
from specmate.design.models import Draft
from specmate.design.operations import draft_state, scoped_draft
from specmate.operations import Context, NotFound


def stock_record(draft, in_project=None) -> dict:
    record = {
        "definition_id": str(draft.definition_id),
        "workspace_id": str(draft.definition.workspace_id),
        "name": draft.definition.name,
        **draft_state(draft),
    }
    if in_project is not None:
        record["in_project"] = bool(in_project)
    return record


def list_stocks(user, workspace_id: UUID | None = None, project_id: UUID | None = None):
    """Every wire stock draft in the library; a project context lists its references first."""
    from specmate.catalog.scope import library_scope, references_definition

    workspace, project = library_scope(user, workspace_id, project_id)
    drafts = Draft.objects.select_related("definition").filter(
        definition__workspace=workspace, definition__kind="wire_stock"
    )
    order = ["definition__created_at", "id"]
    if project is not None:
        drafts = drafts.annotate(in_project=references_definition(project, "definition_id"))
        order.insert(0, "-in_project")
    return [
        stock_record(d, d.in_project if project is not None else None)
        for d in drafts.order_by(*order)
    ]


def get_stock(user, draft_id: UUID) -> dict:
    draft = scoped_draft(
        Context(user=user, via="internal", request_id="stock-read"), draft_id, Perm.WORKSPACE_READ
    )
    if draft.definition.kind != "wire_stock":
        raise NotFound("Stock draft not found.")
    return stock_record(draft)
