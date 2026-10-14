"""Workspace source inventory; displayed provenance receives a fresh workspace check."""

import json
from uuid import UUID

from django.http import FileResponse, HttpResponse
from django.utils.http import content_disposition_header
from ninja import Router

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.operations import NotFound
from specmate.sources import blobstore, editing
from specmate.sources.authority import authorize_revision
from specmate.sources.models import SourceArchiveExpansion, SourceBundleRevision

router = Router(tags=["sources"])


@router.get(
    "/projects/{workspace_id}/revisions", operation_id="sources_revisions_via_project"
)  # TRANSITIONAL alias (P3 removes)
@router.get("/workspaces/{workspace_id}/revisions")
def list_revisions(request, workspace_id: UUID, after: UUID | None = None):
    user = current_actor(request.user)
    workspace = authorize(user, workspace_id, Perm.WORKSPACE_READ)
    # Stable bounded pages fail closed before emitting any inaccessible cursor or name.
    rows = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(bundle__workspace=workspace)
        .order_by("id")
    )
    if after is not None:
        rows = rows.filter(id__gt=after)
    candidates = list(rows[:51])
    result = []
    for revision in candidates[:50]:
        result.append(
            {
                "revision_id": str(revision.id),
                "bundle_id": str(revision.bundle_id),
                "name": revision.bundle.name,
                "role": revision.bundle.role,
                "number": revision.number,
                "manifest_sha256": revision.manifest_sha256,
                "derived_from": str(revision.bundle.derived_from_id)
                if revision.bundle.derived_from_id
                else None,
            }
        )
    return {
        "workspace_id": str(workspace.id),
        "revisions": result,
        "next_after": str(candidates[49].id) if len(candidates) > 50 else None,
    }


@router.get("/revisions/{revision_id}")
def read_revision(request, revision_id: UUID):
    user = current_actor(request.user)
    revision = SourceBundleRevision.objects.select_related("bundle").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Source revision not found.")
    authorize_revision(user, revision)
    return {
        "workspace_id": str(revision.bundle.workspace_id),
        "revision_id": str(revision.id),
        "name": revision.bundle.name,
        "role": revision.bundle.role,
        "number": revision.number,
        "derived_from": str(revision.bundle.derived_from_id)
        if revision.bundle.derived_from_id
        else None,
        "manifest_sha256": revision.manifest_sha256,
        "manifest": json.loads(bytes(revision.manifest)),
        "expansion": expansion_provenance(revision),
        "edit_submission": editing.submission_provenance(revision),
    }


@router.get("/revisions/{revision_id}/file")
def download_file(request, revision_id: UUID, path: str):
    user = current_actor(request.user)
    revision = SourceBundleRevision.objects.select_related("bundle").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Source revision not found.")
    authorize_revision(user, revision)
    file = revision.files.select_related("blob").filter(path=path).first()
    if file is None:
        raise NotFound("Source file not found.")
    response = FileResponse(
        blobstore.open_blob(file.blob.sha256), content_type="application/octet-stream"
    )
    response["Content-Disposition"] = content_disposition_header(True, file.path.rsplit("/", 1)[-1])
    response["X-Content-Type-Options"] = "nosniff"
    return response


@router.get("/revisions/{revision_id}/handoff")
def export_handoff(request, revision_id: UUID):
    """Deterministic editing handoff ZIP of an exact revision; bytes stay inert."""
    user = current_actor(request.user)
    revision = SourceBundleRevision.objects.select_related("bundle").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Source revision not found.")
    authorize_revision(user, revision)
    data, filename = editing.export_handoff(revision)
    response = HttpResponse(data, content_type="application/zip")
    response["Content-Disposition"] = content_disposition_header(True, filename)
    response["X-Content-Type-Options"] = "nosniff"
    response["X-Specmate-Baseline-Revision"] = str(revision.id)
    return response


def expansion_provenance(revision):
    expansion = (
        SourceArchiveExpansion.objects.select_related("archive_file__blob")
        .filter(revision=revision)
        .first()
    )
    if expansion is None:
        return None
    return {
        "parser": expansion.parser,
        "source_revision_id": str(expansion.archive_file.revision_id),
        "path": expansion.archive_file.path,
        "sha256": expansion.archive_file.blob.sha256,
        "rights": expansion.archive_file.rights,
        "execution": "none",
    }
