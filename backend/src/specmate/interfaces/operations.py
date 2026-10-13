from specmate.access.permissions import Perm, authorize
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
from specmate.interfaces.contracts import (
    KINDS,
    CaptureInterface,
    CreateInterface,
    ReadInterface,
    TraceInterface,
    UpdateInterface,
)
from specmate.interfaces.queries import (
    authorize_content,
    dependency_revisions,
    inspect_revision,
    parse_content,
    trace,
)
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import project_scope


def interface_draft(ctx, draft_id, permission, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind not in KINDS:
        raise NotFound("Interface draft unavailable.")
    # Incomplete generic drafts may omit the typed payload until their first edit.
    # Present content always retains full closure validation and authorization.
    if "interface" in draft.content:
        dependency_revisions(ctx.user, draft.definition, draft.content)
    return draft


def scope(ctx, p, permission=Perm.DESIGN_EDIT):
    if isinstance(p, CreateInterface):
        project = p.project_id
    else:
        project = interface_draft(ctx, p.draft_id, permission).definition.project_id
    namespace = project_scope(ctx, project, permission)
    if isinstance(p, (CreateInterface, UpdateInterface)):
        authorize_content(ctx.user, {"interface": p.interface.model_dump(mode="json")})
    if isinstance(p, CreateInterface):
        name = "interface.create"
    elif isinstance(p, UpdateInterface):
        name = "interface.update"
    else:
        name = "interface.freeze" if permission == Perm.DESIGN_FREEZE else "interface.snapshot"
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation=name,
            key=ctx.idempotency_key,
            scope__in=[namespace, "legacy"],
        ):
            authorize_stored(ctx, record.result)
    return namespace


def replay(ctx, p, stored, permission=Perm.DESIGN_EDIT):
    scope(ctx, p, permission)
    authorize_stored(ctx, stored)


def authorize_stored(ctx, stored):
    """The exact receipt can retain protected inputs a later draft has removed."""
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
    "interface.create",
    CreateInterface,
    summary="Create a body, pinout or boundary mapping.",
    authorize_replay=replay,
    idempotency_scope=scope,
)
def create(ctx: Context, p: CreateInterface):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    content = {"interface": p.interface.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return create_definition(
        ctx,
        CreateDefinition(
            project_id=p.project_id, name=p.name, kind=p.interface.kind, content=content
        ),
    )


@operation(
    "interface.update",
    UpdateInterface,
    summary="Replace typed interface draft content.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def update(ctx: Context, p: UpdateInterface):
    draft = interface_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    if draft.definition.kind != p.interface.kind:
        raise ValidationFailed("An interface definition cannot change kind.")
    content = {"interface": p.interface.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


def capture_payload(ctx, p, permission):
    draft = interface_draft(ctx, p.draft_id, permission, lock=True)
    parse_content(draft.content, draft.definition.kind)
    return CaptureDraft(
        draft_id=p.draft_id,
        dependencies=dependency_revisions(ctx.user, draft.definition, draft.content),
    )


@operation(
    "interface.snapshot",
    CaptureInterface,
    summary="Snapshot an interface with exact pins.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def snapshot(ctx: Context, p: CaptureInterface):
    return snapshot_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_EDIT))


@operation(
    "interface.freeze",
    CaptureInterface,
    summary="Freeze an interface and exact dependencies.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: replay(ctx, p, stored, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda ctx, p: scope(ctx, p, Perm.DESIGN_FREEZE),
)
def freeze(ctx: Context, p: CaptureInterface):
    return freeze_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_FREEZE))


@operation(
    "interface.read",
    ReadInterface,
    summary="Read a frozen body, pinout or mapping.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadInterface):
    return inspect_revision(ctx.user, p.revision_id)


@operation(
    "interface.trace",
    TraceInterface,
    summary="Trace declared external/internal passages.",
    supports_idempotency=False,
)
def trace_interface(ctx: Context, p: TraceInterface):
    return trace(ctx.user, p.revision_id, p.external_contact_id)
