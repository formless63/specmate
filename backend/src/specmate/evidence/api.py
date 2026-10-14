from uuid import UUID

from ninja import Query, Router, Schema
from pydantic import Field

from specmate.evidence.contracts import ListEvidence, ReadRecordedResult
from specmate.evidence.queries import list_evidence
from specmate.evidence.recorded import read_recorded
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


@router.get("/workspaces/{workspace_id}")
def get_workspace_evidence(request, workspace_id: UUID, query: Query[EvidenceQuery]):
    return list_evidence(
        request.user,
        ListEvidence(
            workspace_id=workspace_id,
            kinds=query.kind,
            subject_id=query.subject_id,
            offset=query.offset,
            limit=query.limit,
        ),
    )


@router.get("/recorded/{record_id}")
def get_recorded(request, record_id: UUID):
    return read_recorded(request.user, ReadRecordedResult(record_id=record_id))
