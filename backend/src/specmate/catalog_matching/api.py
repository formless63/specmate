from uuid import UUID

from ninja import Router

from specmate.catalog_matching import queries
from specmate.catalog_matching.contracts import SuggestSupplierMatches
from specmate.catalog_matching.suppliers import suggest_supplier_matches
from specmate.operations import Context

router = Router(tags=["catalog matching"])


@router.get("/revisions/{revision_id}/supplier-suggestions")
def supplier_suggestions(
    request,
    revision_id: UUID,
    source_variant_id: UUID,
    after: UUID | None = None,
    limit: int = 25,
):
    return suggest_supplier_matches(
        Context(user=request.user, via="api", request_id="supplier-suggestions"),
        SuggestSupplierMatches(
            source_revision_id=revision_id,
            source_variant_id=source_variant_id,
            after=after,
            limit=limit,
        ),
    )


@router.get("/candidates/{candidate_id}")
def candidate(request, candidate_id: UUID):
    return queries.get_candidate(request.user, candidate_id)


@router.get("/revisions/{revision_id}")
def candidates(request, revision_id: UUID, after: UUID | None = None, limit: int = 25):
    return queries.list_candidates(request.user, revision_id, after=after, limit=limit)


@router.get("/evidence-files")
def evidence_files(
    request, workspace_id: UUID | None = None, after: int | None = None, limit: int = 50
):
    return queries.list_evidence_files(request.user, workspace_id, after=after, limit=limit)
