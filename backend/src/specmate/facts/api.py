from uuid import UUID

from ninja import Query, Router

from specmate.access.permissions import Perm, authorize
from specmate.facts.contracts import FactQuery
from specmate.facts.models import FactSubject
from specmate.facts.queries import read_facts, subject_result, subject_with_assertions

router = Router(tags=["facts"])


@router.get("/subjects/{subject_id}")
def inspect_subject(request, subject_id: UUID, query: Query[FactQuery]):
    return read_facts(
        request.user, subject_id, query.property, offset=query.offset, limit=query.limit
    )


@router.get("/projects/{project_id}/subjects")
def list_subjects(request, project_id: UUID, offset: int = 0, limit: int = 50):
    workspace = authorize(request.user, project_id, Perm.WORKSPACE_READ)
    subjects = FactSubject.objects.filter(workspace=workspace).order_by("created_at")
    # Bounds are independent of the number of records. No unguarded count is returned.
    from specmate.operations import ValidationFailed

    if offset < 0 or not 1 <= limit <= 100:
        raise ValidationFailed("Invalid pagination.")
    result = []
    for subject in subjects[offset : offset + limit]:
        readable, _ = subject_with_assertions(request.user, subject.id)
        result.append(subject_result(readable))
    return result
