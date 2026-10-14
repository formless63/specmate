from uuid import UUID

from django.http import JsonResponse
from ninja import Router

from specmate.collaboration import queries
from specmate.collaboration.contracts import InboxPage, ReviewPage
from specmate.operations import ValidationFailed

router = Router(tags=["collaboration"])


def private_json(value):
    response = JsonResponse(value)
    response["Cache-Control"] = "private, no-store"
    return response


@router.get("/reviews/{review_id}")
def read_review(request, review_id: UUID):
    return private_json(queries.inspect(request.user, review_id))


@router.get("/projects/{project_id}/reviews")
def reviews(request, project_id: UUID, after: UUID | None = None, limit: int = 25):
    if not 1 <= limit <= 100:
        raise ValidationFailed("Invalid pagination.")
    return private_json(
        queries.project_reviews(
            request.user, ReviewPage(project_id=project_id, after=after, limit=limit)
        )
    )


@router.get("/projects/{project_id}/inbox")
def inbox(
    request, project_id: UUID, after: UUID | None = None, limit: int = 25, unread_only: bool = False
):
    if not 1 <= limit <= 100:
        raise ValidationFailed("Invalid pagination.")
    return private_json(
        queries.inbox(
            request.user,
            InboxPage(project_id=project_id, after=after, limit=limit, unread_only=unread_only),
        )
    )


@router.get("/notifications/{notification_id}")
def notification(request, notification_id: UUID):
    return private_json(queries.notification_result(request.user, notification_id))
