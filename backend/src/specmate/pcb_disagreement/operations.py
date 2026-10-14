from specmate.access.permissions import Perm, authorize
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    create_definition,
    freeze_draft,
    scoped_draft,
    update_draft,
)
from specmate.operations import Context, NotFound, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope
from specmate.pcb_disagreement.contracts import (
    KINDS,
    CaptureReview,
    CreateReview,
    ReadReview,
    UpdateReview,
)
from specmate.pcb_disagreement.queries import (
    authorize_value,
    dependency_revisions,
    inspect_revision,
    parse_content,
)


def review_draft(ctx, draft_id, permission=Perm.WORKSPACE_READ, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind not in KINDS:
        raise NotFound("PCB source review draft unavailable.")
    dependency_revisions(ctx.user, draft.definition, draft.content)
    return draft


def scope(ctx, p, permission=Perm.DESIGN_EDIT):
    if isinstance(p, CreateReview):
        # Creating a review is an additive workspace item, open to contributors.
        permission = Perm.ITEM_CREATE
        scope_id = p.workspace_id
    else:
        scope_id = review_draft(ctx, p.draft_id, permission).definition.workspace_id
    namespace = workspace_scope(ctx, scope_id, permission)
    name = (
        "pcb_disagreement.create"
        if isinstance(p, CreateReview)
        else "pcb_disagreement.update"
        if isinstance(p, UpdateReview)
        else "pcb_disagreement.freeze"
    )
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation=name,
            key=ctx.idempotency_key,
            scope=namespace,
        ):
            retained_authority(ctx, record.result, permission)
    if isinstance(p, (CreateReview, UpdateReview)):
        authorize_value(ctx.user, p.value)
    return namespace


def retained_authority(ctx, stored, permission):
    draft = stored.get("draft", stored)
    if "draft_id" in draft:
        review_draft(ctx, draft["draft_id"], permission)
    if "content" in draft:
        value = parse_content(draft["content"])
        if value:
            authorize_value(ctx.user, value)
    if "revision_id" in stored:
        inspect_revision(ctx.user, stored["revision_id"])


def replay(ctx, p, stored, permission=Perm.DESIGN_EDIT):
    scope(ctx, p, permission)
    retained_authority(ctx, stored, permission)


@operation(
    "pcb_disagreement.create",
    CreateReview,
    summary="Record independent exact-source assertions or a comparison review.",
    authorize_replay=replay,
    idempotency_scope=scope,
)
def create(ctx: Context, p: CreateReview):
    workspace = authorize(ctx.user, p.workspace_id, Perm.ITEM_CREATE)
    authorize_value(ctx.user, p.value)
    return create_definition(
        ctx,
        CreateDefinition(
            workspace_id=workspace.id,
            name=p.name,
            kind=p.value.kind,
            content={p.value.kind: p.value.model_dump(mode="json")},
        ),
    )


@operation(
    "pcb_disagreement.update",
    UpdateReview,
    summary="Edit assertions or independent discrepancy review with concurrency control.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def update(ctx: Context, p: UpdateReview):
    review_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    authorize_value(ctx.user, p.value)
    return update_draft(
        ctx,
        UpdateDraft(draft_id=p.draft_id, changes={p.value.kind: p.value.model_dump(mode="json")}),
    )


@operation(
    "pcb_disagreement.freeze",
    CaptureReview,
    summary="Freeze exact source assertions and comparison decisions.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: replay(ctx, p, stored, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda ctx, p: scope(ctx, p, Perm.DESIGN_FREEZE),
)
def freeze(ctx: Context, p: CaptureReview):
    draft = review_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE, lock=True)
    return freeze_draft(
        ctx,
        CaptureDraft(
            draft_id=draft.id,
            dependencies=dependency_revisions(ctx.user, draft.definition, draft.content),
        ),
    )


@operation(
    "pcb_disagreement.read",
    ReadReview,
    summary="Inspect exact source assertions, conflicts and review without choosing a source.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadReview):
    return inspect_revision(ctx.user, p.revision_id)
