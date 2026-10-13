from uuid import UUID

from ninja import Router

from specmate.catalog_matching import queries

router = Router(tags=["catalog matching"])


@router.get("/candidates/{candidate_id}")
def candidate(request, candidate_id: UUID):
    return queries.get_candidate(request.user, candidate_id)


@router.get("/revisions/{revision_id}")
def candidates(request, revision_id: UUID, after: UUID | None = None, limit: int = 25):
    return queries.list_candidates(request.user, revision_id, after=after, limit=limit)


@router.get("/projects/{project_id}/evidence-files")
def evidence_files(request, project_id: UUID, after: int | None = None, limit: int = 50):
    return queries.list_evidence_files(request.user, project_id, after=after, limit=limit)
