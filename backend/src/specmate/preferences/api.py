from uuid import UUID

from django.http import JsonResponse
from ninja import Router

from specmate.preferences import queries

router = Router(tags=["preferences"])


@router.get("")
def read(request, workspace_id: UUID):
    response = JsonResponse(queries.read(request.user, workspace_id))
    response["Cache-Control"] = "private, no-store"
    return response
