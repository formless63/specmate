from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.operations import evidence_fields
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    authorize_design_content,
    create_definition,
    freeze_draft,
    scoped_draft,
    update_draft,
)
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.passive_passages import queries
from specmate.passive_passages.contracts import (
    CaptureModel,
    CreateModel,
    InterpretModel,
    ReadModel,
    ReviewModel,
    UpdateModel,
)
from specmate.passive_passages.models import PassageReview


def retained(ctx, operation_name, scope):
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation=operation_name,
            key=ctx.idempotency_key,
            scope__in=[scope, "legacy"],
        ):
            result = record.result
            if operation_name in {"passage.create", "passage.update"}:
                draft = scoped_draft(ctx, result["draft_id"], Perm.DESIGN_EDIT)
                authorize_design_content(ctx.user, draft.definition, result["content"])
                queries.closure(ctx.user, result["content"], "passage_model")
            elif operation_name == "passage.freeze":
                queries.rows(ctx.user, result["revision_id"], edit=True)
                draft = scoped_draft(ctx, result["draft"]["draft_id"], Perm.DESIGN_FREEZE)
                queries.closure(ctx.user, result["draft"]["content"], draft.definition.kind)
            else:
                queries.rows(ctx.user, result["revision_id"], edit=True)


def create_scope(ctx, p):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    queries.closure(
        ctx.user, {"passages": p.model.model_dump(mode="json")}, "passage_model", validate=False
    )
    scope = f"project:{p.project_id}"
    retained(ctx, "passage.create", scope)
    return scope


def change_scope(name, permission):
    def resolve(ctx, p):
        draft = scoped_draft(ctx, p.draft_id, permission)
        if isinstance(p, UpdateModel):
            queries.closure(
                ctx.user,
                {"passages": p.model.model_dump(mode="json")},
                "passage_model",
                validate=False,
            )
        scope = f"project:{draft.definition.project_id}"
        retained(ctx, name, scope)
        return scope

    return resolve


def review_scope(ctx, p):
    revision, _, _, _ = queries.rows(ctx.user, p.revision_id, edit=True)
    evidence_fields(ctx.user, p.evidence)
    scope = f"project:{revision.definition.project_id}"
    retained(ctx, "passage.review", scope)
    return scope


def replay(ctx, p, stored):
    # Scope callbacks already recheck current supplied and retained closures before replay.
    pass


@operation(
    "passage.create",
    CreateModel,
    summary="Create an explicit idealized passive model pinned to an exact copper graph.",
    idempotency_scope=create_scope,
    authorize_replay=replay,
)
def create(ctx: Context, p: CreateModel):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    content = {"passages": p.model.model_dump(mode="json")}
    queries.closure(ctx.user, content, "passage_model")
    return create_definition(
        ctx,
        CreateDefinition(
            project_id=p.project_id, name=p.name, kind="passage_model", content=content
        ),
    )


@operation(
    "passage.update",
    UpdateModel,
    summary="Update passive model declarations with independent optimistic concurrency.",
    requires_expected_state=True,
    idempotency_scope=change_scope("passage.update", Perm.DESIGN_EDIT),
    authorize_replay=replay,
)
def update(ctx: Context, p: UpdateModel):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"passages": p.model.model_dump(mode="json")}
    queries.closure(ctx.user, draft.content, draft.definition.kind)
    queries.closure(ctx.user, content, draft.definition.kind)
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


@operation(
    "passage.freeze",
    CaptureModel,
    summary="Freeze exact passive assertions and root graph pins; review remains separate.",
    requires_expected_state=True,
    idempotency_scope=change_scope("passage.freeze", Perm.DESIGN_FREEZE),
    authorize_replay=replay,
)
def freeze(ctx: Context, p: CaptureModel):
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE, lock=True)
    if draft.definition.kind != "passage_model":
        raise ValidationFailed("Draft is not a passive model.")
    dependencies = queries.dependency_revisions(ctx.user, draft.definition, draft.content)
    return freeze_draft(ctx, CaptureDraft(draft_id=p.draft_id, dependencies=dependencies))


@operation(
    "passage.read",
    ReadModel,
    summary="Read an exact passive model, source graph and currently authorized review history.",
    supports_idempotency=False,
)
def read(ctx: Context, p: ReadModel):
    return queries.result(ctx.user, p.revision_id)


@operation(
    "passage.review",
    ReviewModel,
    summary="Append a deliberate review of an exact frozen passive model.",
    requires_expected_state=True,
    idempotency_scope=review_scope,
    authorize_replay=replay,
)
def review(ctx: Context, p: ReviewModel):
    revision, _, _, reviews = queries.rows(ctx.user, p.revision_id, edit=True, lock=True)
    evidence = evidence_fields(ctx.user, p.evidence)
    if ctx.require_expected_state() != queries.state(reviews):
        raise Conflict(
            "Passive model review changed.",
            details={"current": queries.result(ctx.user, revision.id)},
        )
    PassageReview.objects.create(
        model_revision=revision,
        version=len(reviews) + 1,
        decision=p.decision,
        basis=p.basis,
        reviewed_by=ctx.user,
        **evidence,
    )
    return queries.result(ctx.user, revision.id)


@operation(
    "passage.interpret",
    InterpretModel,
    summary="Evaluate bounded idealized declared-model paths with distinct query semantics.",
    supports_idempotency=False,
)
def query(ctx: Context, p: InterpretModel):
    return queries.interpret_model(ctx.user, p)
