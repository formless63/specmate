"""Knowledge reads refresh the current actor; mutations use the shared operation endpoint."""

from uuid import UUID

from django.http import JsonResponse
from ninja import Query, Router
from pydantic import Json

from specmate.catalog_matching.queries import current_actor
from specmate.facts.contracts import Target
from specmate.knowledge.previews import preview_attachment
from specmate.knowledge.queries import project_items, read_item
from specmate.knowledge.search import search_knowledge
from specmate.knowledge.search_contracts import PreviewAttachment, SearchKnowledge
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


def _fresh(value):
    response = JsonResponse(value)
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


class SearchQuery(SearchKnowledge):
    # Query strings carry a structured target as JSON; shared operations use objects.
    target: Json[Target] | None = None


@router.get("/search")
def search(request, payload: Query[SearchQuery]):
    return _fresh(search_knowledge(request.user, payload))


@router.get("/preview")
def preview(request, payload: Query[PreviewAttachment]):
    return _fresh(preview_attachment(request.user, payload))
