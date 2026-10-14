from uuid import UUID

from ninja import Query, Router, Schema
from pydantic import Field

from specmate.evidence.contracts import ListEvidence
from specmate.evidence.queries import list_evidence
from specmate.evidence.taxonomy import Kind, taxonomy

router = Router(tags=["evidence"])


class EvidenceQuery(Schema):
    kind: list[Kind] | None = None
    subject_id: UUID | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


@router.get("/taxonomy")
def get_taxonomy(request):
    return taxonomy()


@router.get("/projects/{project_id}")
def get_project_evidence(request, project_id: UUID, query: Query[EvidenceQuery]):
    return list_evidence(
        request.user,
        ListEvidence(
            project_id=project_id,
            kinds=query.kind,
            subject_id=query.subject_id,
            offset=query.offset,
            limit=query.limit,
        ),
    )
