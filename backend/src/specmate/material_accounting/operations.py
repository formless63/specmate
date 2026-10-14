from dataclasses import replace

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Draft, Snapshot
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    authorize_snapshot,
    create_definition,
    freeze_draft,
    update_draft,
)
from specmate.material_accounting.contracts import (
    CapturePlan,
    CreatePlan,
    MaterialPlan,
    ReadPlan,
    UpdatePlan,
)
from specmate.material_accounting.queries import closure, dependency_revisions, inspect_revision
from specmate.operations import Context, NotFound, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope


def plan_draft(ctx, draft_id, permission=Perm.WORKSPACE_READ, lock=False):
    ctx = replace(ctx, user=current_actor(ctx.user))
    query = Draft.objects.select_related("definition")
    if lock:
        query = query.select_for_update(of=("self",))
    draft = query.filter(id=draft_id).first()
    if draft is None:
        raise NotFound("Material plan draft unavailable.")
    authorize(ctx.user, draft.definition.workspace_id, permission)
    if draft.definition.kind != "material_plan":
        raise NotFound("Material plan draft unavailable.")
    closure(ctx.user, draft.content, draft.definition.kind, authority_only=True)
    return draft


def retained(ctx, stored, permission):
    draft = stored.get("draft", stored)
    if "draft_id" in draft:
        plan_draft(ctx, draft["draft_id"], permission)
    if "content" in draft:
        closure(ctx.user, draft["content"], authority_only=True)
    if "snapshot_id" in stored:
        snapshot = Snapshot.objects.select_related("definition").get(id=stored["snapshot_id"])
        authorize_snapshot(ctx.user, snapshot)


def scope(ctx, payload, permission=Perm.DESIGN_EDIT):
    project_id = (
        payload.project_id
        if isinstance(payload, CreatePlan)
        else plan_draft(ctx, payload.draft_id, permission).definition.workspace_id
    )
    namespace = workspace_scope(ctx, project_id, permission)
    if isinstance(payload, (CreatePlan, UpdatePlan)):
        closure(
            ctx.user,
            {"material_plan": payload.plan.model_dump(mode="json")},
            authority_only=True,
        )
    name = (
        "material_plan.create"
        if isinstance(payload, CreatePlan)
        else "material_plan.update"
        if isinstance(payload, UpdatePlan)
        else "material_plan.freeze"
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
    "material_plan.create",
    CreatePlan,
    summary="Create an exact preparation material accounting plan.",
    authorize_replay=replay,
    idempotency_scope=scope,
)
def create(ctx: Context, payload: CreatePlan):
    authorize(ctx.user, payload.project_id, Perm.DESIGN_EDIT)
    content = {"material_plan": payload.plan.model_dump(mode="json")}
    closure(ctx.user, content)
    return create_definition(
        ctx,
        CreateDefinition(
            project_id=payload.project_id,
            name=payload.name,
            kind="material_plan",
            content=content,
        ),
    )


@operation(
    "material_plan.update",
    UpdatePlan,
    summary="Edit material declarations and observations with an optimistic token.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def update(ctx: Context, payload: UpdatePlan):
    draft = plan_draft(ctx, payload.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"material_plan": payload.plan.model_dump(mode="json")}
    closure(ctx.user, content)
    result = update_draft(ctx, UpdateDraft(draft_id=payload.draft_id, changes=content))
    return {"definition_id": str(draft.definition_id), **result}


@operation(
    "material_plan.freeze",
    CapturePlan,
    summary="Freeze exact material plan and preparation dependencies.",
    requires_expected_state=True,
    authorize_replay=lambda c, p, r: replay(c, p, r, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda c, p: scope(c, p, Perm.DESIGN_FREEZE),
)
def freeze(ctx: Context, payload: CapturePlan):
    draft = plan_draft(ctx, payload.draft_id, Perm.DESIGN_FREEZE, lock=True)
    return freeze_draft(
        ctx,
        CaptureDraft(
            draft_id=draft.id,
            dependencies=dependency_revisions(ctx.user, draft.definition, draft.content),
        ),
    )


@operation(
    "material_plan.read",
    ReadPlan,
    summary="Inspect an exact material plan build sheet.",
    supports_idempotency=False,
)
def read(ctx: Context, payload: ReadPlan):
    return inspect_revision(ctx.user, payload.revision_id)


@operation(
    "material_plan.authority",
    MaterialPlan,
    summary="Recheck current material-plan dependency and evidence authority.",
    supports_idempotency=False,
)
def check_authority(ctx: Context, payload: MaterialPlan):
    closure(ctx.user, {"material_plan": payload.model_dump(mode="json")}, authority_only=True)
    return {"authorized": True}
