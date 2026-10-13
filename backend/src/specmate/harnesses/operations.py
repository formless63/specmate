from dataclasses import replace

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
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
from specmate.harnesses.contracts import (
    CaptureHarness,
    CreateHarness,
    InspectRelationships,
    ReadHarness,
    UpdateHarness,
)
from specmate.harnesses.queries import (
    authorize_content,
    dependency_revisions,
    inspect_relationships,
    inspect_revision,
    parse_content,
)
from specmate.operations import Context, NotFound, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import LEGACY_SCOPE, project_scope


def harness_draft(ctx, draft_id, permission, lock=False):
    ctx = replace(ctx, user=current_actor(ctx.user))
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != "harness":
        raise NotFound("Harness draft unavailable.")
    # Incomplete generic drafts may omit the typed payload until their first edit.
    # Present content always retains full closure validation and authorization.
    if "harness" in draft.content:
        dependency_revisions(ctx.user, draft.definition, draft.content)
    return draft


def scope(ctx, p, permission=Perm.DESIGN_EDIT):
    if isinstance(p, CreateHarness):
        project = p.project_id
    else:
        project = harness_draft(ctx, p.draft_id, permission).definition.project_id
    namespace = project_scope(ctx, project, permission)
    if isinstance(p, (CreateHarness, UpdateHarness)):
        authorize_content(
            ctx.user, {"harness": p.harness.model_dump(mode="json")}, authority_only=True
        )
    if ctx.idempotency_key:
        name = (
            "harness.create"
            if isinstance(p, CreateHarness)
            else "harness.update"
            if isinstance(p, UpdateHarness)
            else "harness.freeze"
            if permission == Perm.DESIGN_FREEZE
            else "harness.snapshot"
        )
        records = IdempotencyRecord.objects.select_for_update().filter(
            actor=ctx.user, operation=name, key=ctx.idempotency_key
        )
        prior = (
            records.filter(scope=namespace).first() or records.filter(scope=LEGACY_SCOPE).first()
        )
        if prior:
            retained(ctx, prior.result)
    return namespace


def retained(ctx, stored):
    draft = stored.get("draft", stored)
    if draft.get("draft_id"):
        harness_draft(ctx, draft["draft_id"], Perm.PROJECT_READ)
    if "content" in stored:
        authorize_content(ctx.user, stored["content"])
    if "revision_id" in stored:
        inspect_revision(ctx.user, stored["revision_id"])
    if "snapshot_id" in stored:
        from specmate.design.models import Snapshot
        from specmate.design.operations import authorize_snapshot

        snapshot = Snapshot.objects.select_related("definition").get(id=stored["snapshot_id"])
        authorize_snapshot(ctx.user, snapshot)


def replay(ctx, p, stored, permission=Perm.DESIGN_EDIT):
    scope(ctx, p, permission)
    retained(ctx, stored)


@operation(
    "harness.create",
    CreateHarness,
    summary="Compose exact harness stock and endpoint revisions.",
    authorize_replay=replay,
    idempotency_scope=scope,
)
def create(ctx: Context, p: CreateHarness):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    content = {"harness": p.harness.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return create_definition(
        ctx,
        CreateDefinition(project_id=p.project_id, name=p.name, kind="harness", content=content),
    )


@operation(
    "harness.update",
    UpdateHarness,
    summary="Replace typed harness draft content.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def update(ctx: Context, p: UpdateHarness):
    harness_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"harness": p.harness.model_dump(mode="json")}
    authorize_content(ctx.user, content)
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


def capture_payload(ctx, p, permission):
    draft = harness_draft(ctx, p.draft_id, permission, lock=True)
    parse_content(draft.content, draft.definition.kind)
    return CaptureDraft(
        draft_id=p.draft_id,
        dependencies=dependency_revisions(ctx.user, draft.definition, draft.content),
    )


@operation(
    "harness.snapshot",
    CaptureHarness,
    summary="Snapshot a harness with exact pins.",
    requires_expected_state=True,
    authorize_replay=replay,
    idempotency_scope=scope,
)
def snapshot(ctx: Context, p: CaptureHarness):
    return snapshot_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_EDIT))


@operation(
    "harness.freeze",
    CaptureHarness,
    summary="Freeze a harness and exact dependencies.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: replay(ctx, p, stored, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda ctx, p: scope(ctx, p, Perm.DESIGN_FREEZE),
)
def freeze(ctx: Context, p: CaptureHarness):
    return freeze_draft(ctx, capture_payload(ctx, p, Perm.DESIGN_FREEZE))


@operation(
    "harness.read",
    ReadHarness,
    summary="Read frozen harness assignments and conductor identities.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadHarness):
    return inspect_revision(ctx.user, p.revision_id, p.quantity)


@operation(
    "harness.declared_relationships",
    InspectRelationships,
    summary="Inspect only explicit joint, bond and breakout relationship declarations.",
    supports_idempotency=False,
)
def declared_relationships(ctx: Context, p: InspectRelationships):
    return inspect_relationships(ctx.user, p.revision_id, p.terminal)
