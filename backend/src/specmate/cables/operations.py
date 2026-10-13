from specmate.access.permissions import Perm, authorize
from specmate.cables.contracts import (
    CaptureCable,
    CreateCable,
    ReadCable,
    UpdateCable,
)
from specmate.cables.queries import (
    authorize_content,
    dependency_revisions,
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
from specmate.operations import Context, NotFound, operation
from specmate.operations.scope import project_scope


def cable_draft(ctx, draft_id, permission, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != "cable":
        raise NotFound("Cable draft unavailable.")
    # Incomplete generic drafts may omit the typed payload until their first edit.
    # Present content always retains full closure validation and authorization.
    if "cable" in draft.content:
        dependency_revisions(ctx.user, draft.definition, draft.content)
    return draft


def scope(ctx, p, permission=Perm.DESIGN_EDIT):
    if isinstance(p, CreateCable):
        project = p.project_id
    else:
        project = cable_draft(ctx, p.draft_id, permission).definition.project_id
    return project_scope(ctx, project, permission)


def replay(ctx, p, stored, permission=Perm.DESIGN_EDIT):
    scope(ctx, p, permission)
    if isinstance(p, (CreateCable, UpdateCable)):
        authorize_content(ctx.user, {"cable": p.cable.model_dump(mode="json")})
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
    "cable.create",
    CreateCable,
    summary="Compose exact cable stock and endpoint revisions.",
    authorize_replay=replay,
    idempotency_scope=scope,
)
def create(ctx: Context, p: CreateCable):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    content = {"cable": p.cable.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return create_definition(
        ctx,
        CreateDefinition(project_id=p.project_id, name=p.name, kind="cable", content=content),
    )


@operation(
    "cable.update",
    UpdateCable,
    summary="Replace typed cable draft content.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def update(ctx: Context, p: UpdateCable):
    cable_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"cable": p.cable.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


def capture_payload(ctx, p, permission):
    draft = cable_draft(ctx, p.draft_id, permission, lock=True)
    parse_content(draft.content, draft.definition.kind)
    return CaptureDraft(
        draft_id=p.draft_id,
        dependencies=dependency_revisions(ctx.user, draft.definition, draft.content),
    )


@operation(
    "cable.snapshot",
    CaptureCable,
    summary="Snapshot a cable with exact pins.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def snapshot(ctx: Context, p: CaptureCable):
    return snapshot_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_EDIT))


@operation(
    "cable.freeze",
    CaptureCable,
    summary="Freeze a cable and exact dependencies.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: replay(ctx, p, stored, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda ctx, p: scope(ctx, p, Perm.DESIGN_FREEZE),
)
def freeze(ctx: Context, p: CaptureCable):
    return freeze_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_FREEZE))


@operation(
    "cable.read",
    ReadCable,
    summary="Read frozen cable assignments and conductor identities.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadCable):
    return inspect_revision(ctx.user, p.revision_id)
