"""Bounded current-authority receipt lists and shared-operation file download adapter."""

import base64
from uuid import UUID

from django.http import HttpResponse, JsonResponse
from ninja import Router

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.operations import Context, OperationError, execute
from specmate.preparation_documents.contracts import Download
from specmate.preparation_documents.models import DocumentSet
from specmate.preparation_documents.operations import authorized_set, result

router = Router(tags=["preparation-documents"])


@router.get("/projects/{project_id}")
def records(request, project_id: UUID):
    user = current_actor(request.user)
    authorize(user, project_id, Perm.PROJECT_READ)
    rows = DocumentSet.objects.filter(root_revision__definition__project_id=project_id).order_by(
        "-created_at", "id"
    )[:50]
    visible = []
    for row in rows:
        try:
            record = authorized_set(user, row.id)
        except OperationError:
            continue
        visible.append(result(record))
    return JsonResponse(
        {"document_sets": visible, "listing": "latest_50_candidates_no_hidden_total"},
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/sets/{set_id}")
def receipt(request, set_id: UUID):
    return JsonResponse(
        result(authorized_set(request.user, set_id)), headers={"Cache-Control": "private, no-store"}
    )


@router.post("/download")
def file(request, payload: Download):
    response = execute(
        "preparation_documents.download",
        Context(user=request.user, via="api", request_id="preparation-document-download"),
        payload.model_dump(mode="json"),
    ).result
    output = HttpResponse(
        base64.b64decode(response["data_base64"]), content_type=response["media_type"]
    )
    output["Content-Disposition"] = f'attachment; filename="{response["filename"]}"'
    output["Digest"] = "sha-256=" + response["sha256"]
    output["Cache-Control"] = "private, no-store"
    output["X-Content-Type-Options"] = "nosniff"
    output["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    return output
