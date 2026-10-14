from dataclasses import replace

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Snapshot
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    authorize_snapshot,
    create_definition,
    freeze_draft,
    scoped_draft,
    update_draft,
)
from specmate.operations import Context, NotFound, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope
from specmate.preparation.calculation import compute
from specmate.preparation.contracts import (
    CaptureProfile,
    ComputeCuts,
    CreateProfile,
    PreparationProfile,
    ReadProfile,
    UpdateProfile,
)
from specmate.preparation.queries import closure, dependency_revisions, inspect_profile


def profile_draft(ctx, draft_id, permission=Perm.WORKSPACE_READ, lock=False):
    ctx = replace(ctx, user=current_actor(ctx.user))
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != "preparation_profile":
        raise NotFound("Preparation profile draft unavailable.")
    closure(ctx.user, draft.content, draft.definition.kind, authority_only=True)
    return draft


def retained(ctx, stored, permission):
    draft = stored.get("draft", stored)
    if "draft_id" in draft:
        profile_draft(ctx, draft["draft_id"], permission)
    if "content" in draft:
        closure(ctx.user, draft["content"], authority_only=True)
    if "snapshot_id" in stored:
        snapshot = Snapshot.objects.select_related("definition").get(id=stored["snapshot_id"])
        authorize_snapshot(ctx.user, snapshot)


def scope(ctx, payload, permission=Perm.DESIGN_EDIT):
    project_id = (
        payload.project_id
        if isinstance(payload, CreateProfile)
        else profile_draft(ctx, payload.draft_id, permission).definition.workspace_id
    )
    namespace = workspace_scope(ctx, project_id, permission)
    if isinstance(payload, (CreateProfile, UpdateProfile)):
        closure(
            ctx.user,
            {"preparation_profile": payload.profile.model_dump(mode="json")},
            authority_only=True,
        )
    name = (
        "preparation.create"
        if isinstance(payload, CreateProfile)
        else "preparation.update"
        if isinstance(payload, UpdateProfile)
        else "preparation.freeze"
    )
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation=name,
            key=ctx.idempotency_key,
            scope=namespace,
        ):
            retained(ctx, record.result, permission)
    return namespace


def replay(ctx, payload, stored, permission=Perm.DESIGN_EDIT):
    scope(ctx, payload, permission)
    retained(ctx, stored, permission)


@operation(
    "preparation.create",
    CreateProfile,
    summary="Create an exact-stock arithmetic preparation profile.",
    authorize_replay=replay,
    idempotency_scope=scope,
)
def create(ctx: Context, payload: CreateProfile):
    authorize(ctx.user, payload.project_id, Perm.DESIGN_EDIT)
    content = {"preparation_profile": payload.profile.model_dump(mode="json")}
    closure(ctx.user, content)
    return create_definition(
        ctx,
        CreateDefinition(
            project_id=payload.project_id,
            name=payload.name,
            kind="preparation_profile",
            content=content,
        ),
    )


@operation(
    "preparation.update",
    UpdateProfile,
    summary="Edit preparation formulas with an optimistic state token.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def update(ctx: Context, payload: UpdateProfile):
    draft = profile_draft(ctx, payload.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"preparation_profile": payload.profile.model_dump(mode="json")}
    closure(ctx.user, content)
    result = update_draft(ctx, UpdateDraft(draft_id=payload.draft_id, changes=content))
    return {"definition_id": str(draft.definition_id), **result}


@operation(
    "preparation.freeze",
    CaptureProfile,
    summary="Freeze exact preparation formulas and stock dependencies.",
    requires_expected_state=True,
    authorize_replay=lambda c, p, r: replay(c, p, r, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda c, p: scope(c, p, Perm.DESIGN_FREEZE),
)
def freeze(ctx: Context, payload: CaptureProfile):
    draft = profile_draft(ctx, payload.draft_id, Perm.DESIGN_FREEZE, lock=True)
    return freeze_draft(
        ctx,
        CaptureDraft(
            draft_id=draft.id,
            dependencies=dependency_revisions(ctx.user, draft.definition, draft.content),
        ),
    )


@operation(
    "preparation.read",
    ReadProfile,
    summary="Inspect an exact preparation formula revision.",
    supports_idempotency=False,
)
def read(ctx: Context, payload: ReadProfile):
    return inspect_profile(ctx.user, payload.revision_id)


@operation(
    "preparation.compute",
    ComputeCuts,
    summary="Compute reviewed cut suggestions for exact physical sections.",
    supports_idempotency=False,
)
def calculate(ctx: Context, payload: ComputeCuts):
    return compute(ctx.user, payload)


@operation(
    "preparation.authority",
    PreparationProfile,
    summary="Recheck current profile source authority without applying formulas.",
    supports_idempotency=False,
)
def check_authority(ctx: Context, payload: PreparationProfile):
    closure(ctx.user, {"preparation_profile": payload.model_dump(mode="json")}, authority_only=True)
    return {"authorized": True}
