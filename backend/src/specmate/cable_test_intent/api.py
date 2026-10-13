from uuid import UUID

from django.http import HttpResponse
from ninja import Router

from specmate.access.permissions import Perm
from specmate.cable_test_intent.operations import plan_draft
from specmate.cable_test_intent.queries import portable_package, result
from specmate.catalog_matching.queries import current_actor
from specmate.design.operations import draft_state
from specmate.operations import Context

router = Router(tags=["cable-test-intent"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = plan_draft(
        Context(user=current_actor(request.user), via="api", request_id="read"),
        draft_id,
        Perm.PROJECT_READ,
    )
    return {"definition_id": str(value.definition_id), **draft_state(value)}


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID):
    return result(request.user, revision_id)


@router.get("/revisions/{revision_id}/package")
def package(request, revision_id: UUID):
    data, sha256 = portable_package(request.user, revision_id)
    response = HttpResponse(data, content_type="application/json")
    response["Content-Disposition"] = f'attachment; filename="cable-test-plan-{revision_id}.json"'
    response["Digest"] = f"sha-256={sha256}"
    response["Cache-Control"] = "private, no-store"
    return response
