"""Knowledge reads refresh the current actor; mutations use the shared operation endpoint."""

from uuid import UUID

from ninja import Router

from specmate.catalog_matching.queries import current_actor
from specmate.knowledge.queries import project_items, read_item
from specmate.operations import ValidationFailed

router = Router(tags=["knowledge"])


@router.get("/projects/{project_id}/items")
def list_items(request, project_id: UUID, offset: int = 0, limit: int = 50):
    if offset < 0 or not 1 <= limit <= 100:
        raise ValidationFailed("Invalid pagination.")
    return project_items(current_actor(request.user), project_id, offset, limit)


@router.get("/items/{item_id}")
def inspect_item(request, item_id: UUID):
    return read_item(current_actor(request.user), item_id)
