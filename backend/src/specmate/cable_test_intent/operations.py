"""Cable expectation commands share drafts, compare-and-set and immutable captures."""

from specmate.access.permissions import Perm
from specmate.cable_test_intent import queries
from specmate.cable_test_intent.contracts import (
    CapturePlan,
    CreatePlan,
    DeriveFromIntent,
    InspectTarget,
    ReadPlan,
    UpdatePlan,
)
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    authorize_snapshot,
    create_definition,
    freeze_draft,
    scoped_draft,
    snapshot_draft,
    update_draft,
)
from specmate.design.pins import item_workspace, pin_workspace
from specmate.operations import Context, NotFound, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope


def plan_draft(ctx, draft_id, permission=Perm.WORKSPACE_READ, *, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != "cable_test_plan":
        raise NotFound("Cable test plan draft unavailable.")
    queries.closure(ctx.user, draft.content, draft.definition.kind)
    return draft


def retained(ctx, stored, permission):
    draft = stored.get("draft", stored)
    if "draft_id" in draft:
        plan_draft(ctx, draft["draft_id"], permission)
    if "content" in draft:
        queries.closure(ctx.user, draft["content"], "cable_test_plan", validate=False)
    if "revision_id" in stored:
        queries.result(ctx.user, stored["revision_id"])
    if "snapshot_id" in stored:
        from specmate.design.models import Snapshot

        snapshot = Snapshot.objects.select_related("definition").get(id=stored["snapshot_id"])
        authorize_snapshot(ctx.user, snapshot)


def scope(name, permission):
    def resolve(ctx, p):
        if isinstance(p, (CreatePlan, UpdatePlan)):
            # Supplied references before any retained semantic diagnostics or keyed mismatch.
            queries.closure(
                ctx.user,
                {"test_plan": p.test_plan.model_dump(mode="json")},
                "cable_test_plan",
                validate=False,
            )
        needed = permission
        if isinstance(p, CreatePlan):
            # Creating adds a workspace collection item (item.create); no project is involved.
            needed = Perm.ITEM_CREATE
            workspace_id = item_workspace(ctx.user, p.workspace_id).id
        else:
            workspace_id = plan_draft(ctx, p.draft_id, permission).definition.workspace_id
        namespace = workspace_scope(ctx, workspace_id, needed)
        if ctx.idempotency_key is not None:
            for record in IdempotencyRecord.objects.filter(
                actor=ctx.user,
                operation=name,
                key=ctx.idempotency_key,
                scope=namespace,
            ):
                retained(ctx, record.result, permission)
        return namespace

    return resolve


def replay(ctx, p, stored):
    # Scope rechecked supplied and all retained current/legacy outcomes before replay.
    pass


@operation(
    "cable_test_plan.create",
    CreatePlan,
    summary="Create authored test expectations and labels for exact cable scope.",
    idempotency_scope=scope("cable_test_plan.create", Perm.ITEM_CREATE),
    authorize_replay=replay,
    access=Perm.ITEM_CREATE,
)
def create(ctx: Context, p: CreatePlan):
    scope("cable_test_plan.create", Perm.ITEM_CREATE)(ctx, p)
    workspace = item_workspace(ctx.user, p.workspace_id)
    content = {"test_plan": p.test_plan.model_dump(mode="json")}
    with pin_workspace(workspace.id):
        queries.closure(ctx.user, content, "cable_test_plan")
    return create_definition(
        ctx,
        CreateDefinition(
            workspace_id=workspace.id, name=p.name, kind="cable_test_plan", content=content
        ),
    )


@operation(
    "cable_test_plan.update",
    UpdatePlan,
    summary="Update test expectations under the plan's independent state token.",
    requires_expected_state=True,
    idempotency_scope=scope("cable_test_plan.update", Perm.DESIGN_EDIT),
    authorize_replay=replay,
    access=Perm.DESIGN_EDIT,
)
def update(ctx: Context, p: UpdatePlan):
    scope("cable_test_plan.update", Perm.DESIGN_EDIT)(ctx, p)
    plan_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"test_plan": p.test_plan.model_dump(mode="json")}
    queries.closure(ctx.user, content, "cable_test_plan")
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


def capture(ctx, p, permission):
    draft = plan_draft(ctx, p.draft_id, permission, lock=True)
    return CaptureDraft(
        draft_id=p.draft_id,
        dependencies=queries.dependency_revisions(ctx.user, draft.definition, draft.content),
    )


@operation(
    "cable_test_plan.freeze",
    CapturePlan,
    summary="Freeze declared test intent without recording a physical test.",
    requires_expected_state=True,
    idempotency_scope=scope("cable_test_plan.freeze", Perm.DESIGN_FREEZE),
    authorize_replay=replay,
    access=Perm.DESIGN_FREEZE,
)
def freeze(ctx: Context, p: CapturePlan):
    scope("cable_test_plan.freeze", Perm.DESIGN_FREEZE)(ctx, p)
    return freeze_draft(ctx, capture(ctx, p, Perm.DESIGN_FREEZE))


@operation(
    "cable_test_plan.snapshot",
    CapturePlan,
    summary="Capture exact test expectations and cable context.",
    requires_expected_state=True,
    idempotency_scope=scope("cable_test_plan.snapshot", Perm.DESIGN_EDIT),
    authorize_replay=replay,
    access=Perm.DESIGN_EDIT,
)
def snapshot(ctx: Context, p: CapturePlan):
    scope("cable_test_plan.snapshot", Perm.DESIGN_EDIT)(ctx, p)
    return snapshot_draft(ctx, capture(ctx, p, Perm.DESIGN_EDIT))


@operation(
    "cable_test_plan.read",
    ReadPlan,
    summary="Read exact test intent and retained evidence under current authority.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read(ctx: Context, p: ReadPlan):
    return queries.result(ctx.user, p.revision_id)


@operation(
    "cable_test_plan.inspect_target",
    InspectTarget,
    summary="Inspect exact cable terminals within a frozen contextual occurrence.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def inspect_target(ctx: Context, p: InspectTarget):
    return queries.inspect_target(ctx.user, p)


@operation(
    "cable_test_plan.derive_from_intent",
    DeriveFromIntent,
    summary=(
        "Propose continuity and isolation expectations for an exact frozen cable from its "
        "cable intent; nothing is stored or frozen."
    ),
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def derive_from_intent(ctx: Context, p: DeriveFromIntent):
    from specmate.cable_test_intent.derive import derive

    return derive(ctx.user, p)


@operation(
    "cable_test_plan.package",
    ReadPlan,
    summary="Read an inert portable cable expectation package; no source execution.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def package(ctx: Context, p: ReadPlan):
    import json

    data, sha256 = queries.portable_package(ctx.user, p.revision_id)
    return {"package": json.loads(data), "sha256": sha256}
