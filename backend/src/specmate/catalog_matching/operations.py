from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.contracts import ProposeMatch, ReviewMatch
from specmate.catalog_matching.models import MatchCandidate, MatchReview
from specmate.catalog_matching.queries import (
    authorize_file,
    candidate_result,
    candidate_rows,
    get_candidate,
    state,
)
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.models import SourceBundleFile


def evidence_fields(user, evidence):
    source_file = None
    if evidence.status == "registered_file":
        revision = get_bundle_revision(user, evidence.source_bundle_revision_id)
        source_file = (
            SourceBundleFile.objects.select_related("blob")
            .filter(revision=revision, path=evidence.source_path)
            .first()
        )
        if source_file is None:
            raise NotFound("Evidence file not found.")
        authorize_file(user, source_file)
    return {
        "evidence_status": evidence.status,
        "citation": evidence.citation,
        "source_file": source_file,
    }


def proposal_references(ctx, payload):
    source = get_revision(ctx.user, payload.source_revision_id)
    target = get_revision(ctx.user, payload.target_revision_id)
    evidence = evidence_fields(ctx.user, payload.evidence)
    authorize(ctx.user, source.definition.workspace_id, Perm.DESIGN_EDIT)
    # Authorize every reference before semantic diagnostics reveal its relationship.
    if source.definition_id == target.definition_id:
        raise ValidationFailed("Matching requires distinct engineering definition identities.")
    return source, target, evidence


def proposal_scope(ctx, payload):
    source, _, _ = proposal_references(ctx, payload)
    scope = f"workspace:{source.definition.workspace_id}"
    authorize_retained_outcome(ctx, "catalog.propose_match", scope)
    return scope


def review_scope(ctx, payload):
    _, source, _, _ = candidate_rows(ctx.user, payload.candidate_id, edit=True)
    evidence_fields(ctx.user, payload.evidence)
    scope = f"workspace:{source.definition.workspace_id}"
    authorize_retained_outcome(ctx, "catalog.review_match", scope)
    return scope


def authorize_retained_outcome(ctx, name, scope):
    """Recheck old references before the executor exposes a keyed mismatch diagnostic."""
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user, operation=name, key=ctx.idempotency_key, scope=scope
        ):
            candidate_rows(ctx.user, record.result["candidate_id"], edit=True)


def authorize_proposal_replay(ctx, payload, stored):
    proposal_references(ctx, payload)
    candidate_rows(ctx.user, stored["candidate_id"], edit=True)


def authorize_review_replay(ctx, payload, stored):
    candidate_rows(ctx.user, payload.candidate_id, edit=True)
    evidence_fields(ctx.user, payload.evidence)


@operation(
    "catalog.propose_match",
    ProposeMatch,
    summary="Record a candidate correspondence between distinct exact engineering identities.",
    idempotency_scope=proposal_scope,
    authorize_replay=authorize_proposal_replay,
)
def propose_match(ctx: Context, payload: ProposeMatch):
    source, target, evidence = proposal_references(ctx, payload)
    candidate = MatchCandidate.objects.create(
        source_revision=source,
        target_revision=target,
        association_kind=payload.association_kind,
        observed_source_identifier=payload.observed_source_identifier,
        observed_target_identifier=payload.observed_target_identifier,
        basis=payload.basis,
        proposed_by=ctx.user,
        **evidence,
    )
    return candidate_result(candidate, source, target, [])


@operation(
    "catalog.review_match",
    ReviewMatch,
    summary="Append a reviewed correspondence decision; no identity or consumer is rewritten.",
    requires_expected_state=True,
    idempotency_scope=review_scope,
    authorize_replay=authorize_review_replay,
)
def review_match(ctx: Context, payload: ReviewMatch):
    candidate, _, _, reviews = candidate_rows(ctx.user, payload.candidate_id, edit=True, lock=True)
    evidence = evidence_fields(ctx.user, payload.evidence)
    if ctx.require_expected_state() != state(reviews):
        raise Conflict(
            "Match review changed.", details={"current": get_candidate(ctx.user, candidate.id)}
        )
    MatchReview.objects.create(
        candidate=candidate,
        version=len(reviews) + 1,
        decision=payload.decision,
        basis=payload.basis,
        reviewed_by=ctx.user,
        **evidence,
    )
    return get_candidate(ctx.user, candidate.id)
