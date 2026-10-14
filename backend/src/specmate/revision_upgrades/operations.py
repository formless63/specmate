from specmate.access.permissions import Perm
from specmate.assemblies.contracts import ReadAssembly
from specmate.catalog_matching.operations import evidence_fields
from specmate.design.models import Draft
from specmate.design.operations import authorize_design_content, draft_state, scoped_draft
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.revision_upgrades import queries
from specmate.revision_upgrades.contracts import (
    ApplyUpgrade,
    ProposeUpgrade,
    ReadConsumers,
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
                    target = queries.rows(ctx.user, record.result["proposal_id"])[3]
                    authorize_design_content(ctx.user, target.definition, draft)


def propose_scope(ctx, p):
    snapshot, closure, _, _ = queries.references(
        ctx.user,
        p.owning_snapshot_id,
        p.old_revision_id,
        p.candidate_revision_id,
        edit=True,
        validate=False,
    )
    # A resolvable nested consumer must be currently editable before key diagnostics.
    if tuple(p.context_path) in closure.nodes:
        queries.consumer(ctx.user, snapshot, closure, p.context_path, edit=True)
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
    snapshot, closure, _, _ = queries.references(
        ctx.user,
        p.owning_snapshot_id,
        p.old_revision_id,
        p.candidate_revision_id,
        edit=True,
        relation=p.relation,
    )
    queries.consumer(ctx.user, snapshot, closure, p.context_path, edit=True)
    queries.rows(ctx.user, stored["proposal_id"], edit=True)


def mutation_replay(ctx, p, stored):
    mutation_scope(ctx, p)


@operation(
    "upgrade.propose",
    ProposeUpgrade,
    summary=(
        "Propose selected exact-pin upgrades or declared replacements in one consuming context"
        " without changing consumers."
    ),
    idempotency_scope=propose_scope,
    authorize_replay=propose_replay,
)
def propose(ctx: Context, p: ProposeUpgrade):
    snapshot, closure, old, candidate = queries.references(
        ctx.user,
        p.owning_snapshot_id,
        p.old_revision_id,
        p.candidate_revision_id,
        edit=True,
        relation=p.relation,
    )
    target = queries.consumer(ctx.user, snapshot, closure, p.context_path, edit=True)
    plan = queries.selected_content(ctx.user, target, old, candidate, p.paths, p.relation)
    # The candidate pin itself must be admissible in the consuming definition; undecided
    # references into the selected uses are reviewed later, not validated as retained.
    authorize_design_content(ctx.user, target.definition, plan.probe)
    proposal = UpgradeProposal.objects.create(
        owning_snapshot=snapshot,
        old_revision=old,
        candidate_revision=candidate,
        relation=p.relation,
        replacement_basis=p.replacement_basis or "",
        context_path=p.context_path,
        consumer_snapshot=target.snapshot if target.context_path else None,
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
    summary=(
        "Append explicit feature, relationship and assignment correspondence with discipline"
        " impact review."
    ),
    requires_expected_state=True,
    idempotency_scope=mutation_scope,
    authorize_replay=mutation_replay,
)
def review(ctx: Context, p: ReviewUpgrade):
    proposal, _, _, target, old, candidate, reviews = queries.rows(
        ctx.user, p.proposal_id, edit=True, lock=True
    )
    evidence = evidence_fields(ctx.user, p.evidence)
    if ctx.require_expected_state() != queries.state(reviews):
        raise Conflict(
            "Upgrade review changed.", details={"current": queries.result(ctx.user, proposal.id)}
        )
    features = [feature.model_dump(mode="json") for feature in p.features]
    relationships = [item.model_dump(mode="json") for item in p.relationships]
    assignments = [item.model_dump(mode="json") for item in p.assignments]
    if p.decision == "accepted":
        plan = queries.plan_for(ctx.user, proposal, target, old, candidate)
        queries.reviewed_content(ctx.user, plan, features, relationships, assignments)
    UpgradeReview.objects.create(
        proposal=proposal,
        version=len(reviews) + 1,
        decision=p.decision,
        basis=p.basis,
        features=features,
        relationship_decisions=relationships,
        assignment_decisions=assignments,
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
    proposal, _, _, consumer, old, candidate, reviews = queries.rows(
        ctx.user, p.proposal_id, edit=True, lock=True
    )
    target = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True) if p.draft_id else None
    if ctx.require_expected_state() != queries.state(reviews):
        raise Conflict(
            "Upgrade review changed.", details={"current": queries.result(ctx.user, proposal.id)}
        )
    if not reviews or reviews[-1].decision != "accepted":
        raise ValidationFailed("Adoption requires the current accepted correspondence review.")
    plan = queries.plan_for(ctx.user, proposal, consumer, old, candidate)
    content = queries.review_content(ctx.user, plan, reviews[-1])
    authorize_design_content(ctx.user, consumer.definition, content)
    baseline = consumer.content
    if target:
        if target.state_token != p.draft_expected_state:
            raise Conflict(
                "Selected owning draft changed.", details={"current": draft_state(target)}
            )
        if target.definition_id != consumer.definition.id or target.content != baseline:
            raise ValidationFailed(
                "Selected draft must belong to the exact consuming definition and match the"
                " proposal baseline; re-propose after edits."
            )
        target.content = content
        target.version += 1
        target.updated_by = ctx.user
        target.save(update_fields=["content", "version", "updated_by", "updated_at"])
    else:
        target = Draft.objects.create(
            definition=consumer.definition,
            content=content,
            base_revision=consumer.revision,
            updated_by=ctx.user,
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
        "context_path": proposal.context_path,
        "parent_propagation": "required" if proposal.context_path else "not_applicable",
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


@operation(
    "upgrade.consumers",
    ReadConsumers,
    summary="List authorized frozen consumers in one project that pin an exact revision.",
    supports_idempotency=False,
)
def consumers(ctx: Context, p: ReadConsumers):
    return queries.consumers(ctx.user, p.project_id, p.revision_id)
