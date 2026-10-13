import json

from specmate.access.permissions import Perm
from specmate.assemblies.contracts import ReadAssembly
from specmate.catalog_matching.operations import evidence_fields
from specmate.design.models import Draft, Revision
from specmate.design.operations import authorize_design_content, draft_state, scoped_draft
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.revision_upgrades import queries
from specmate.revision_upgrades.contracts import (
    ApplyUpgrade,
    ProposeUpgrade,
    ReadUpgrade,
    ReviewUpgrade,
)
from specmate.revision_upgrades.models import UpgradeApplication, UpgradeProposal, UpgradeReview


def retained(ctx, name, scope):
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user, operation=name, key=ctx.idempotency_key, scope__in=[scope, "legacy"]
        ):
            queries.rows(ctx.user, record.result["proposal_id"], edit=True)
            if "draft_id" in record.result:
                scoped_draft(ctx, record.result["draft_id"], Perm.DESIGN_EDIT)
                draft = record.result.get("content")
                if draft is not None:
                    snapshot = queries.rows(ctx.user, record.result["proposal_id"])[1]
                    authorize_design_content(ctx.user, snapshot.definition, draft)


def propose_scope(ctx, p):
    snapshot, _, _, _ = queries.references(
        ctx.user,
        p.owning_snapshot_id,
        p.old_revision_id,
        p.candidate_revision_id,
        edit=True,
        validate=False,
    )
    scope = f"project:{snapshot.definition.project_id}"
    retained(ctx, "upgrade.propose", scope)
    return scope


def mutation_scope(ctx, p):
    data = queries.rows(ctx.user, p.proposal_id, edit=True)
    if isinstance(p, ReviewUpgrade):
        evidence_fields(ctx.user, p.evidence)
    if isinstance(p, ApplyUpgrade) and p.draft_id:
        scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT)
    scope = f"project:{data[1].definition.project_id}"
    retained(ctx, "upgrade.review" if isinstance(p, ReviewUpgrade) else "upgrade.apply", scope)
    return scope


def propose_replay(ctx, p, stored):
    queries.references(
        ctx.user, p.owning_snapshot_id, p.old_revision_id, p.candidate_revision_id, edit=True
    )
    queries.rows(ctx.user, stored["proposal_id"], edit=True)


def mutation_replay(ctx, p, stored):
    mutation_scope(ctx, p)


@operation(
    "upgrade.propose",
    ProposeUpgrade,
    summary="Propose selected exact-pin direct assembly upgrades without changing consumers.",
    idempotency_scope=propose_scope,
    authorize_replay=propose_replay,
)
def propose(ctx: Context, p: ProposeUpgrade):
    snapshot, closure, old, candidate = queries.references(
        ctx.user, p.owning_snapshot_id, p.old_revision_id, p.candidate_revision_id, edit=True
    )
    queries.selected_content(ctx.user, snapshot, closure, old, candidate, p.paths)
    proposal = UpgradeProposal.objects.create(
        owning_snapshot=snapshot,
        old_revision=old,
        candidate_revision=candidate,
        paths=p.paths,
        basis=p.basis,
        proposed_by=ctx.user,
    )
    return queries.result(ctx.user, proposal.id)


@operation(
    "upgrade.read",
    ReadUpgrade,
    summary="Read a currently authorized proposal and immutable review history.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadUpgrade):
    return queries.result(ctx.user, p.proposal_id)


@operation(
    "upgrade.review",
    ReviewUpgrade,
    summary="Append explicit feature correspondence and discipline impact review.",
    requires_expected_state=True,
    idempotency_scope=mutation_scope,
    authorize_replay=mutation_replay,
)
def review(ctx: Context, p: ReviewUpgrade):
    proposal, snapshot, closure, old, candidate, reviews = queries.rows(
        ctx.user, p.proposal_id, edit=True, lock=True
    )
    evidence = evidence_fields(ctx.user, p.evidence)
    if ctx.require_expected_state() != queries.state(reviews):
        raise Conflict(
            "Upgrade review changed.", details={"current": queries.result(ctx.user, proposal.id)}
        )
    features = [feature.model_dump(mode="json") for feature in p.features]
    if p.decision == "accepted":
        queries.reviewed_content(
            ctx.user, snapshot, closure, old, candidate, proposal.paths, features
        )
    UpgradeReview.objects.create(
        proposal=proposal,
        version=len(reviews) + 1,
        decision=p.decision,
        basis=p.basis,
        features=features,
        impacts=p.impacts.model_dump(mode="json"),
        reviewed_by=ctx.user,
        **evidence,
    )
    return queries.result(ctx.user, proposal.id)


@operation(
    "upgrade.apply",
    ApplyUpgrade,
    summary="Adopt a reviewed proposal into an explicitly selected owning draft.",
    requires_expected_state=True,
    idempotency_scope=mutation_scope,
    authorize_replay=mutation_replay,
)
def apply(ctx: Context, p: ApplyUpgrade):
    proposal, snapshot, closure, old, candidate, reviews = queries.rows(
        ctx.user, p.proposal_id, edit=True, lock=True
    )
    target = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True) if p.draft_id else None
    if ctx.require_expected_state() != queries.state(reviews):
        raise Conflict(
            "Upgrade review changed.", details={"current": queries.result(ctx.user, proposal.id)}
        )
    if not reviews or reviews[-1].decision != "accepted":
        raise ValidationFailed("Adoption requires the current accepted correspondence review.")
    content = queries.reviewed_content(
        ctx.user, snapshot, closure, old, candidate, proposal.paths, reviews[-1].features
    )
    authorize_design_content(ctx.user, snapshot.definition, content)
    baseline = json.loads(bytes(snapshot.canonical))["content"]
    if target:
        if target.state_token != p.draft_expected_state:
            raise Conflict(
                "Selected owning draft changed.", details={"current": draft_state(target)}
            )
        if target.definition_id != snapshot.definition_id or target.content != baseline:
            raise ValidationFailed(
                "Selected draft must belong to the exact owning definition and match the"
                "proposal baseline; re-propose after edits."
            )
        target.content = content
        target.version += 1
        target.updated_by = ctx.user
        target.save(update_fields=["content", "version", "updated_by", "updated_at"])
    else:
        base = Revision.objects.filter(snapshot=snapshot).first()
        target = Draft.objects.create(
            definition=snapshot.definition, content=content, base_revision=base, updated_by=ctx.user
        )
    application = UpgradeApplication.objects.create(
        proposal=proposal,
        review=reviews[-1],
        draft=target,
        draft_version=target.version,
        applied_by=ctx.user,
    )
    return {
        "proposal_id": str(proposal.id),
        "application_id": str(application.id),
        "review_id": str(reviews[-1].id),
        "existing_frozen_pins": "retained",
        **draft_state(target),
    }


@operation(
    "upgrade.inspect_owner",
    ReadAssembly,
    summary="Inspect exact owning assembly occurrences with current source-origin authority.",
    supports_idempotency=False,
)
def inspect_owner(ctx: Context, p: ReadAssembly):
    return queries.inspect_owning(ctx.user, p.snapshot_id)
