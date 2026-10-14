from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import (
    CaptureAssembly,
    CreateAssembly,
    ReadAssembly,
    ResolveOccurrence,
    UpdateAssembly,
)
from specmate.assemblies.queries import (
    authorize_content,
    dependency_revisions,
    get_snapshot,
    read_assembly,
    resolve_occurrence,
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
from specmate.operations import Context, ValidationFailed, operation
from specmate.operations.scope import workspace_scope


def create_scope(ctx, p):
    return workspace_scope(ctx, p.project_id, Perm.DESIGN_EDIT)


def edit_scope(ctx, p):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT)
    return workspace_scope(ctx, draft.definition.workspace_id, Perm.DESIGN_EDIT)


def freeze_scope(ctx, p):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE)
    return workspace_scope(ctx, draft.definition.workspace_id, Perm.DESIGN_FREEZE)


def authorize_create_replay(ctx, p, stored):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    authorize_content(ctx.user, stored["content"])


def authorize_update_replay(ctx, p, stored):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT)
    authorize_content(ctx.user, draft.content)
    authorize_content(ctx.user, stored["content"])


def authorize_capture_replay(ctx, p, stored):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT)
    authorize_content(ctx.user, draft.content)
    get_snapshot(ctx.user, stored["snapshot_id"])


def authorize_freeze_replay(ctx, p, stored):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE)
    authorize_content(ctx.user, draft.content)
    get_snapshot(ctx.user, stored["snapshot_id"])
    authorize_content(ctx.user, stored["draft"]["content"])


def capture_payload(ctx, p, permission):
    draft = scoped_draft(ctx, p.draft_id, permission, lock=True)
    if draft.definition.kind != "assembly":
        raise ValidationFailed("Draft is not an assembly.")
    dependencies = dependency_revisions(ctx.user, draft.definition, draft.content)
    return CaptureDraft(draft_id=p.draft_id, dependencies=dependencies)


@operation(
    "assembly.create",
    CreateAssembly,
    summary="Create a reusable assembly with exact child revision pins.",
    authorize_replay=authorize_create_replay,
    idempotency_scope=create_scope,
)
def create_assembly(ctx: Context, p: CreateAssembly):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    content = {"assembly": p.assembly.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return create_definition(
        ctx,
        CreateDefinition(project_id=p.project_id, name=p.name, kind="assembly", content=content),
    )


@operation(
    "assembly.update",
    UpdateAssembly,
    summary="Replace assembly draft content under its concurrency token.",
    requires_expected_state=True,
    authorize_replay=authorize_update_replay,
    idempotency_scope=edit_scope,
)
def update_assembly(ctx: Context, p: UpdateAssembly):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    # Authorize existing closure before generic stale-state conflicts can disclose it.
    authorize_content(ctx.user, draft.content)
    if draft.definition.kind != "assembly":
        raise ValidationFailed("Draft is not an assembly.")
    content = {"assembly": p.assembly.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


@operation(
    "assembly.snapshot",
    CaptureAssembly,
    summary="Snapshot an assembly with its complete exact accessible closure.",
    requires_expected_state=True,
    authorize_replay=authorize_capture_replay,
    idempotency_scope=edit_scope,
)
def capture_assembly(ctx: Context, p: CaptureAssembly):
    return snapshot_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_EDIT))


@operation(
    "assembly.freeze",
    CaptureAssembly,
    summary="Freeze a reusable assembly and its exact revision closure.",
    requires_expected_state=True,
    authorize_replay=authorize_freeze_replay,
    idempotency_scope=freeze_scope,
)
def freeze_assembly(ctx: Context, p: CaptureAssembly):
    return freeze_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_FREEZE))


@operation(
    "assembly.read",
    ReadAssembly,
    summary="Read a permission-complete assembly snapshot.",
    supports_idempotency=False,
)
def inspect_assembly(ctx: Context, p: ReadAssembly):
    return read_assembly(ctx.user, p.snapshot_id)


@operation(
    "assembly.resolve",
    ResolveOccurrence,
    summary="Resolve an exact contextual occurrence and optional feature address.",
    supports_idempotency=False,
)
def inspect_occurrence(ctx: Context, p: ResolveOccurrence):
    return resolve_occurrence(ctx.user, p.snapshot_id, p.path, p.feature_id)
