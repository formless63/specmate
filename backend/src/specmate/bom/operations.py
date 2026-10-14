from specmate.access.permissions import Perm
from specmate.bom.contracts import (
    CaptureBom,
    CreateBom,
    ReadBom,
    UpdateBom,
)
from specmate.bom.queries import (
    authorize_content,
    inspect_revision,
    parse_content,
)
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    create_definition,
    freeze_draft,
    scoped_draft,
    snapshot_draft,
    update_draft,
)
from specmate.design.pins import item_workspace, pin_workspace
from specmate.operations import Context, NotFound, operation
from specmate.operations.scope import workspace_scope


def bom_draft(ctx, draft_id, permission, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != "bom_plan":
        raise NotFound("BOM draft unavailable.")
    # scoped_draft authorizes present typed content and its complete closure.
    return draft


def scope(ctx, p, permission=Perm.DESIGN_EDIT):
    if isinstance(p, CreateBom):
        # Creating adds a workspace collection item (item.create); no project is involved.
        permission = Perm.ITEM_CREATE
        scope_id = item_workspace(ctx.user, p.workspace_id).id
    else:
        scope_id = bom_draft(ctx, p.draft_id, permission).definition.workspace_id
    return workspace_scope(ctx, scope_id, permission)


def replay(ctx, p, stored, permission=Perm.DESIGN_EDIT):
    scope(ctx, p, permission)
    if isinstance(p, (CreateBom, UpdateBom)):
        authorize_content(ctx.user, {"bom": p.bom.model_dump(mode="json")})
    if "content" in stored:
        authorize_content(ctx.user, stored["content"])
    if "revision_id" in stored:
        inspect_revision(ctx.user, stored["revision_id"])
    if "snapshot_id" in stored:
        from specmate.design.models import Snapshot
        from specmate.design.operations import authorize_snapshot

        snapshot = Snapshot.objects.select_related("definition").get(id=stored["snapshot_id"])
        authorize_snapshot(ctx.user, snapshot)


@operation(
    "bom.create",
    CreateBom,
    summary="Create a purpose-specific BOM planning draft.",
    authorize_replay=replay,
    idempotency_scope=scope,
)
def create(ctx: Context, p: CreateBom):
    workspace = item_workspace(ctx.user, p.workspace_id)
    content = {"bom": p.bom.model_dump(mode="json")}
    with pin_workspace(workspace.id):
        authorize_content(ctx.user, content)
    return create_definition(
        ctx,
        CreateDefinition(workspace_id=workspace.id, name=p.name, kind="bom_plan", content=content),
    )


@operation(
    "bom.update",
    UpdateBom,
    summary="Replace typed BOM draft content.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def update(ctx: Context, p: UpdateBom):
    bom_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"bom": p.bom.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


def capture_payload(ctx, p, permission):
    draft = bom_draft(ctx, p.draft_id, permission, lock=True)
    parse_content(draft.content, draft.definition.kind)
    # Generic capture derives and verifies the exact typed dependency pins.
    return CaptureDraft(draft_id=p.draft_id)


@operation(
    "bom.snapshot",
    CaptureBom,
    summary="Snapshot a BOM with exact pins.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def snapshot(ctx: Context, p: CaptureBom):
    return snapshot_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_EDIT))


@operation(
    "bom.freeze",
    CaptureBom,
    summary="Freeze a BOM and exact dependencies.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: replay(ctx, p, stored, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda ctx, p: scope(ctx, p, Perm.DESIGN_FREEZE),
)
def freeze(ctx: Context, p: CaptureBom):
    return freeze_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_FREEZE))


@operation(
    "bom.read",
    ReadBom,
    summary="Read a frozen purpose-specific BOM projection.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadBom):
    return inspect_revision(ctx.user, p.revision_id, p.purpose)
