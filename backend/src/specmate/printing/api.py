from uuid import UUID

from django.http import FileResponse
from django.utils.http import content_disposition_header
from ninja import Router

from specmate.catalog_matching.queries import current_actor
from specmate.operations import Context, NotFound
from specmate.printing.contracts import (
    PARAMETERS,
    PREPARATION_KIND,
    PROFILE_KIND,
    PreparationRef,
    SliceRef,
)
from specmate.printing.operations import (
    read_slice,
    scoped_build,
    slice_options,
    validate_outputs,
)
from specmate.printing.pack import ORCA_PRESETS
from specmate.printing.queries import list_records, list_revisions
from specmate.sources import blobstore

router = Router(tags=["printing"])


def context(request):
    return Context(user=current_actor(request.user), via="api", request_id="read-printing")


@router.get("/parameters")
def parameters(request):
    """The known parameter vocabulary; any parameter not declared in a profile is unknown."""
    return [
        {
            "technology": p.technology,
            "role": p.role,
            "key": p.key,
            "label": p.label,
            "type": p.type,
            "unit": p.unit,
            "minimum": p.minimum,
            "maximum": p.maximum,
            "choices": list(p.choices),
            "slicer_setting": p.slicer_key,
            "orca_settings": list(p.orca_keys),
            "required_for_slicing": p.required_for_slicing,
        }
        for p in PARAMETERS
    ]


@router.get("/orca-presets")
def orca_presets(request):
    """Bundled OrcaSlicer vendor presets exercised with the pinned image, by name only."""
    return [{"key": key, **value} for key, value in ORCA_PRESETS.items()]


@router.get("/profiles")
def profiles(request, workspace_id: UUID | None = None, project_id: UUID | None = None):
    return list_records(request.user, PROFILE_KIND, workspace_id, project_id)


@router.get("/profiles/{definition_id}/revisions")
def profile_revisions(request, definition_id: UUID):
    return list_revisions(request.user, definition_id, PROFILE_KIND)


@router.get("/preparations")
def preparations(request, workspace_id: UUID | None = None, project_id: UUID | None = None):
    return list_records(request.user, PREPARATION_KIND, workspace_id, project_id)


@router.get("/preparations/{definition_id}/revisions")
def preparation_revisions(request, definition_id: UUID):
    return list_revisions(request.user, definition_id, PREPARATION_KIND)


@router.get("/preparation-revisions/{revision_id}/slicing")
def slicing(request, revision_id: UUID):
    return slice_options(context(request), PreparationRef(preparation_revision_id=revision_id))


@router.get("/preparation-revisions/{revision_id}/slices/{build_id}")
def slice_review(request, revision_id: UUID, build_id: UUID):
    return read_slice(
        context(request), SliceRef(preparation_revision_id=revision_id, build_id=build_id)
    )


@router.get("/preparation-revisions/{revision_id}/slices/{build_id}/outputs/{output_id}")
def download_output(request, revision_id: UUID, build_id: UUID, output_id: UUID):
    _, spec, rights, build = scoped_build(context(request), revision_id, build_id)
    _, outputs = validate_outputs(spec, rights, build)
    output = next((o for o in outputs.values() if o.id == output_id), None)
    if output is None:
        raise NotFound("Registered slice output unavailable.")
    response = FileResponse(
        blobstore.open_blob(output.sha256), content_type="application/octet-stream"
    )
    response["Content-Disposition"] = content_disposition_header(True, output.path)
    response["X-Content-Type-Options"] = "nosniff"
    response["Digest"] = f"sha-256={output.sha256}"
    return response
