"""Team records mutate atomically through the shared engineering operation layer."""

from django.utils import timezone

from specmate.access.models import WorkspaceMember
from specmate.access.permissions import Perm, authorize
from specmate.catalog.scope import library_scope
from specmate.catalog_matching.operations import evidence_fields
from specmate.collaboration import queries
from specmate.collaboration.contracts import (
    CompareRevisions,
    CreateReview,
    InboxPage,
    ProposeReviewUpgrade,
    ReadNotification,
    ReadReview,
    RespondReview,
    ReviewPage,
)
from specmate.collaboration.models import ChangeReview, ReviewEntry, ReviewRecipient
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope
from specmate.revision_upgrades.contracts import ProposeUpgrade
from specmate.revision_upgrades.operations import propose as propose_upgrade
from specmate.revision_upgrades.queries import references


def retained(ctx, name, scope):
    """Stored closure precedes even a different-payload key diagnostic."""
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user, operation=name, key=ctx.idempotency_key, scope=scope
        ):
            stored_authority(ctx, record.result)


@queries.private_inputs
def stored_authority(ctx, stored):
    if "notification_id" in stored:
        queries.notification_row(ctx.user, stored["notification_id"])
    else:
        queries.review_rows(ctx.user, stored["review_id"], Perm.DESIGN_EDIT)
        # Historical recipient labels in immutable receipts retain current membership.
        for recipient in stored.get("recipients", []):
            if not WorkspaceMember.objects.filter(
                workspace_id=stored["workspace_id"],
                user_id=recipient["user_id"],
                user__is_active=True,
            ).exists():
                raise NotFound("Change review receipt unavailable.")


def review_scope(ctx, p):
    """The review's workspace (edit authority) and its optional project context."""
    workspace, project = library_scope(ctx.user, p.workspace_id, p.project_id)
    authorize(ctx.user, workspace.id, Perm.DESIGN_EDIT)
    return workspace, project


@queries.private_inputs
def create_authority(ctx, p):
    workspace, _ = review_scope(ctx, p)
    old, candidate = queries.revision_pair(ctx.user, p.old_revision_id, p.candidate_revision_id)
    # Reviews compare revisions of the review's own workspace; nothing crosses workspaces.
    if {old.definition.workspace_id, candidate.definition.workspace_id} != {workspace.id}:
        raise NotFound("Change review inputs unavailable.")
    queries.revision_pair(ctx.user, p.old_revision_id, p.candidate_revision_id)
    knowledge = queries.knowledge_pin(ctx.user, p.knowledge)
    recipients = []
    for name in p.recipients:
        member = (
            WorkspaceMember.objects.select_related("user")
            .filter(workspace=workspace, user__username=name, user__is_active=True)
            .first()
        )
        if member is None:
            raise NotFound("Review recipient unavailable.")
        queries.revision_pair(member.user, p.old_revision_id, p.candidate_revision_id)
        queries.knowledge_pin(member.user, p.knowledge)
        recipients.append(member.user)
    return knowledge, recipients


def create_scope(ctx, p):
    create_authority(ctx, p)
    scope = workspace_scope(ctx, review_scope(ctx, p)[0].id, Perm.DESIGN_EDIT)
    retained(ctx, "collaboration.create", scope)
    return scope


def create_replay(ctx, p, stored):
    create_authority(ctx, p)
    stored_authority(ctx, stored)


@operation(
    "collaboration.create",
    CreateReview,
    summary="Open exact declared change review with internal member-recipient notifications.",
    idempotency_scope=create_scope,
    authorize_replay=create_replay,
)
def create(ctx: Context, p: CreateReview):
    knowledge, recipients = create_authority(ctx, p)
    workspace, project = review_scope(ctx, p)
    review = ChangeReview.objects.create(
        workspace=workspace,
        project=project,
        old_revision_id=p.old_revision_id,
        candidate_revision_id=p.candidate_revision_id,
        knowledge_entry=knowledge[0] if knowledge else None,
        title=p.title,
        created_by=ctx.user,
    )
    ReviewRecipient.objects.bulk_create(
        ReviewRecipient(review=review, user=user) for user in recipients
    )
    entry = ReviewEntry.objects.create(
        review=review,
        number=1,
        action="opened",
        basis=p.basis,
        author=ctx.user,
        request_id=ctx.request_id,
    )
    queries.notify(entry, ctx.user)
    create_authority(ctx, p)
    return queries.summary(ctx.user, review.id, permission=Perm.DESIGN_EDIT)


@queries.private_inputs
def mutation_scope(ctx, p):
    review, _, _, _ = queries.review_rows(ctx.user, p.review_id, Perm.DESIGN_EDIT)
    if isinstance(p, RespondReview):
        evidence_fields(ctx.user, p.evidence)
    if isinstance(p, ProposeReviewUpgrade):
        references(
            ctx.user,
            p.owning_snapshot_id,
            review.old_revision_id,
            review.candidate_revision_id,
            edit=True,
            validate=False,
        )
    name = (
        "collaboration.respond" if isinstance(p, RespondReview) else "collaboration.propose_upgrade"
    )
    scope = workspace_scope(ctx, review.workspace_id, Perm.DESIGN_EDIT)
    retained(ctx, name, scope)
    return scope


def mutation_replay(ctx, p, stored):
    mutation_scope(ctx, p)
    stored_authority(ctx, stored)


@queries.private_inputs
def editable(ctx, p):
    review, _, _, entries = queries.review_rows(ctx.user, p.review_id, Perm.DESIGN_EDIT, lock=True)
    if isinstance(p, RespondReview):
        evidence_fields(ctx.user, p.evidence)
    if isinstance(p, ProposeReviewUpgrade):
        references(
            ctx.user,
            p.owning_snapshot_id,
            review.old_revision_id,
            review.candidate_revision_id,
            edit=True,
            validate=False,
        )
    if ctx.require_expected_state() != review.state_token:
        raise Conflict(
            "Change review advanced; prepared response was not overwritten.",
            details={"current_state": review.state_token},
        )
    if len(entries) >= queries.MAX_ENTRIES:
        raise ValidationFailed("Review history exceeds the supported limit.")
    return review, entries


def append(ctx, review, action, basis, **fields):
    entry = ReviewEntry.objects.create(
        review=review,
        number=review.version + 1,
        action=action,
        basis=basis,
        author=ctx.user,
        request_id=ctx.request_id,
        **fields,
    )
    review.version += 1
    review.save(update_fields=["version"])
    queries.notify(entry, ctx.user)
    return queries.summary(ctx.user, review.id, permission=Perm.DESIGN_EDIT)


@operation(
    "collaboration.respond",
    RespondReview,
    summary="Append team discussion or lifecycle decisions without changing engineering pins.",
    requires_expected_state=True,
    idempotency_scope=mutation_scope,
    authorize_replay=mutation_replay,
)
def respond(ctx: Context, p: RespondReview):
    review, entries = editable(ctx, p)
    evidence = evidence_fields(ctx.user, p.evidence)
    closed = queries.status(entries) == "closed"
    if closed != (p.action == "reopen"):
        raise ValidationFailed(
            "A closed review must be explicitly reopened; an open review cannot be reopened."
        )
    return append(ctx, review, p.action, p.basis, **evidence)


@operation(
    "collaboration.propose_upgrade",
    ProposeReviewUpgrade,
    summary="Attach a deliberately proposed exact supported upgrade; adoption remains separate.",
    requires_expected_state=True,
    idempotency_scope=mutation_scope,
    authorize_replay=mutation_replay,
)
def propose(ctx: Context, p: ProposeReviewUpgrade):
    review, entries = editable(ctx, p)
    if queries.status(entries) == "closed":
        raise ValidationFailed("Reopen the team review before proposing an upgrade.")
    value = propose_upgrade(
        ctx,
        ProposeUpgrade(
            owning_snapshot_id=p.owning_snapshot_id,
            old_revision_id=review.old_revision_id,
            candidate_revision_id=review.candidate_revision_id,
            paths=p.paths,
            basis=p.basis,
        ),
    )
    return append(
        ctx, review, "upgrade_proposed", p.basis, upgrade_proposal_id=value["proposal_id"]
    )


def notification_scope(ctx, p):
    notification = queries.notification_row(ctx.user, p.notification_id)
    scope = workspace_scope(ctx, notification.entry.review.workspace_id)
    retained(ctx, "collaboration.mark_read", scope)
    return scope


def notification_replay(ctx, p, stored):
    notification_scope(ctx, p)
    stored_authority(ctx, stored)


@operation(
    "collaboration.mark_read",
    ReadNotification,
    summary="Acknowledge only the current actor's authorized internal notification.",
    requires_expected_state=True,
    idempotency_scope=notification_scope,
    authorize_replay=notification_replay,
)
def mark_read(ctx: Context, p: ReadNotification):
    notification = queries.notification_row(ctx.user, p.notification_id, lock=True)
    if ctx.require_expected_state() != notification.state_token:
        raise Conflict(
            "Notification read state changed.", details={"current_state": notification.state_token}
        )
    if notification.read_at is None:
        notification.read_at = timezone.now()
        notification.save(update_fields=["read_at"])
    return queries.notification_result(ctx.user, notification.id)


@operation(
    "collaboration.compare",
    CompareRevisions,
    summary="Compare exact declared revision facts and authorized captured parents.",
    supports_idempotency=False,
)
def compare(ctx: Context, p: CompareRevisions):
    return queries.compare(ctx.user, p)


@operation(
    "collaboration.read",
    ReadReview,
    summary="Read freshly authorized team review, declared comparison and exact history.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadReview):
    return queries.inspect(ctx.user, p.review_id)


@operation(
    "collaboration.list",
    ReviewPage,
    summary="List workspace change reviews; a project context lists its reviews first.",
    supports_idempotency=False,
)
def listing(ctx: Context, p: ReviewPage):
    return queries.project_reviews(ctx.user, p)


@operation(
    "collaboration.inbox",
    InboxPage,
    summary="Read the current actor's authorized internal notifications without hidden counts.",
    supports_idempotency=False,
)
def inbox(ctx: Context, p: InboxPage):
    return queries.inbox(ctx.user, p)


@operation(
    "collaboration.notification",
    ReadNotification,
    summary="Inspect only a current recipient-owned authorized notification.",
    supports_idempotency=False,
)
def notification(ctx: Context, p: ReadNotification):
    return queries.notification_result(ctx.user, p.notification_id)
