from uuid import UUID

from ninja import Router

from specmate.design.operations import draft_state
from specmate.operations import Context
from specmate.pcb_disagreement.operations import review_draft
from specmate.pcb_disagreement.queries import inspect_revision, projection, source_files

router = Router(tags=["pcb-source-review"])


@router.get("/drafts/{draft_id}")
def draft(request, draft_id: UUID):
    value = review_draft(Context(user=request.user, via="api", request_id="read"), draft_id)
    return {
        "definition_id": str(value.definition_id),
        **draft_state(value),
        "projection": projection(request.user, value.definition, value.content),
    }


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID):
    return inspect_revision(request.user, revision_id)


@router.get("/sources/{revision_id}")
def sources(request, revision_id: UUID):
    return source_files(request.user, revision_id)


@router.get("/native")
def native_list(request, workspace_id: UUID):
    from specmate.pcb_disagreement.native_operations import list_native

    return list_native(request.user, workspace_id)


@router.get("/native/{interpretation_id}")
def native_read(request, interpretation_id: UUID):
    from specmate.pcb_disagreement.native_operations import (
        interpretation_result,
        scoped_interpretation,
    )

    return interpretation_result(scoped_interpretation(request.user, interpretation_id))


@router.get("/native-options")
def native_available(request, source_revision_id: UUID, path: str, role: str):
    from specmate.pcb_disagreement.native_operations import native_options

    return native_options(request.user, source_revision_id, path, role)
