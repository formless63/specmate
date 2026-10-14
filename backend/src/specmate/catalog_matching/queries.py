"""Current authority precedes correspondence disclosure, including retained history."""

from django.contrib.auth import get_user_model

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.contracts import CandidateResult, EvidenceResult, RevisionIdentity
from specmate.catalog_matching.models import MatchCandidate
from specmate.operations import NotFound, Unauthenticated, ValidationFailed
from specmate.queries import get_bundle_revision, get_revision


def current_actor(user):
    if user is None or not user.is_authenticated:
        raise Unauthenticated("Authentication required.")
    actor = get_user_model().objects.filter(pk=user.pk, is_active=True).first()
    if actor is None:
        raise Unauthenticated("Actor is not active.")
    return actor


def authorize_file(user, source_file):
    if source_file is not None:
        get_bundle_revision(user, source_file.revision_id)
        authorize(user, source_file.blob.workspace_id, Perm.WORKSPACE_READ)


def candidate_rows(user, candidate_id, *, edit=False, lock=False, permission=Perm.DESIGN_EDIT):
    """Current authority over a candidate and all retained evidence; ``edit`` adds ``permission``.

    Proposing candidates is additive (item.create); reviewing them needs design.edit.
    """
    user = current_actor(user)
    queryset = MatchCandidate.objects.select_related(
        "source_file__revision__bundle", "source_file__blob"
    )
    if lock:
        # Nullable evidence joins cannot be locked; serialize on the owning candidate only.
        queryset = queryset.select_for_update(of=("self",))
    candidate = queryset.filter(id=candidate_id).first()
    if candidate is None:
        raise NotFound("Match candidate not found.")
    source = get_revision(user, candidate.source_revision_id)
    target = get_revision(user, candidate.target_revision_id)
    authorize_file(user, candidate.source_file)
    reviews = list(
        candidate.reviews.select_related(
            "source_file__revision__bundle", "source_file__blob"
        ).order_by("version")
    )
    for review in reviews:
        authorize_file(user, review.source_file)
    if edit:
        authorize(user, source.definition.workspace_id, permission)
    return candidate, source, target, reviews


def evidence_result(row):
    source = row.source_file
    return EvidenceResult(
        status=row.evidence_status,
        citation=row.citation,
        source_bundle_revision_id=source.revision_id if source else None,
        source_path=source.path if source else None,
        sha256=source.blob.sha256 if source else None,
        rights=source.rights if source else None,
        media_type=source.media_type if source else None,
    )


def revision_identity(revision):
    return RevisionIdentity(
        revision_id=revision.id,
        definition_id=revision.definition_id,
        workspace_id=revision.definition.workspace_id,
        name=revision.definition.name,
        kind=revision.definition.kind,
        number=revision.number,
        sha256=revision.snapshot.sha256,
    )


def state(reviews):
    return f"match-v{reviews[-1].version if reviews else 0}"


def candidate_result(candidate, source, target, reviews):
    return CandidateResult(
        candidate_id=candidate.id,
        source=revision_identity(source),
        target=revision_identity(target),
        association_kind=candidate.association_kind,
        observed_source_identifier=candidate.observed_source_identifier,
        observed_target_identifier=candidate.observed_target_identifier,
        basis=candidate.basis,
        evidence=evidence_result(candidate),
        state=state(reviews),
        decision=reviews[-1].decision if reviews else "unreviewed",
        created_at=candidate.created_at.isoformat(),
        proposed_by_id=candidate.proposed_by_id,
        reviews=[
            {
                "review_id": review.id,
                "version": review.version,
                "decision": review.decision,
                "basis": review.basis,
                "evidence": evidence_result(review),
                "reviewed_at": review.created_at.isoformat(),
                "reviewed_by_id": review.reviewed_by_id,
            }
            for review in reviews
        ],
    ).model_dump(mode="json")


def get_candidate(user, candidate_id):
    return candidate_result(*candidate_rows(user, candidate_id))


def list_candidates(user, revision_id, *, after=None, limit=25):
    user = current_actor(user)
    get_revision(user, revision_id)
    if not 1 <= limit <= 100:
        raise ValidationFailed("Limit must be between 1 and 100.")
    query = MatchCandidate.objects.filter(source_revision_id=revision_id).order_by("id")
    if after is not None:
        if not query.filter(id=after).exists():
            raise NotFound("Match cursor not found.")
        query = query.filter(id__gt=after)
    # Candidates and their evidence stay inside the source revision's workspace.
    rows = [get_candidate(user, candidate.id) for candidate in query[: limit + 1]]
    return {
        "source_revision_id": str(revision_id),
        "results": rows[:limit],
        "next_after": rows[limit - 1]["candidate_id"] if len(rows) > limit else None,
    }


def list_evidence_files(user, workspace_id=None, *, after=None, limit=50):
    """Exact registered workspace files for human selectors; no name implies verified contents."""
    from specmate.catalog.scope import library_scope
    from specmate.sources.models import SourceBundleFile

    user = current_actor(user)
    workspace, _ = library_scope(user, workspace_id)
    if not 1 <= limit <= 100:
        raise ValidationFailed("Limit must be between 1 and 100.")
    query = (
        SourceBundleFile.objects.select_related("revision__bundle", "blob")
        .filter(revision__bundle__workspace=workspace, blob__workspace=workspace)
        .order_by("id")
    )
    if after is not None:
        if not query.filter(id=after).exists():
            raise NotFound("Evidence cursor not found.")
        query = query.filter(id__gt=after)
    rows = list(query[: limit + 1])
    return {
        "workspace_id": str(workspace.id),
        "results": [
            {
                "file_id": row.id,
                "bundle_name": row.revision.bundle.name,
                "bundle_number": row.revision.number,
                "source_bundle_revision_id": str(row.revision_id),
                "source_path": row.path,
                "sha256": row.blob.sha256,
                "rights": row.rights,
                "media_type": row.media_type,
            }
            for row in rows[:limit]
        ],
        "next_after": rows[limit - 1].id if len(rows) > limit else None,
    }
