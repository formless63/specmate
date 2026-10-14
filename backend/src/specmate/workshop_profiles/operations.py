"""Semantic profile commands use the shared immutable definition/revision stack."""

from uuid import UUID

from pydantic import Field

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Definition, Draft
from specmate.design.operations import check_state, draft_state, scoped_draft
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.operations.scope import workspace_scope
from specmate.workshop_profiles.queries import authorize_profile_content
from specmate.workshop_profiles.schemas import (
    StrictModel,
    WorkshopProfile,
    validate_profile_content,
)


class CreateProfile(StrictModel):
    project_id: UUID
    name: str = Field(min_length=1, max_length=200)
    profile: WorkshopProfile


class UpdateProfile(StrictModel):
    draft_id: UUID
    profile: WorkshopProfile


class FreezeProfile(StrictModel):
    draft_id: UUID


def profile_scope(ctx, p) -> str:
    if isinstance(p, CreateProfile):
        return workspace_scope(ctx, p.project_id, Perm.DESIGN_EDIT)
    permission = Perm.DESIGN_FREEZE if isinstance(p, FreezeProfile) else Perm.DESIGN_EDIT
    draft = scoped_draft(ctx, p.draft_id, permission)
    if draft.definition.kind != "workshop_profile":
        raise NotFound("Workshop profile draft not found.")
    authorize_profile_content(ctx.user, draft.definition, draft.content)
    return workspace_scope(ctx, draft.definition.workspace_id, permission)


def authorize_profile_replay(ctx, p, stored) -> None:
    """Retained responses must pass current checks on their original references."""
    scope = profile_scope(ctx, p)
    if isinstance(p, FreezeProfile):
        from specmate.queries import get_revision

        revision = get_revision(ctx.user, stored["revision_id"])
        if (
            revision.definition.kind != "workshop_profile"
            or scope != f"workspace:{revision.definition.workspace_id}"
        ):
            raise NotFound("Workshop profile revision not found.")
        return
    definition = Definition.objects.filter(
        id=stored["definition_id"], kind="workshop_profile"
    ).first()
    if definition is None or scope != f"workspace:{definition.workspace_id}":
        raise NotFound("Workshop profile not found.")
    authorize_profile_content(ctx.user, definition, stored["content"])


@operation(
    "workshop_profile.create",
    CreateProfile,
    summary="Create an independently versioned workshop preparation/display profile.",
    idempotency_scope=profile_scope,
    authorize_replay=authorize_profile_replay,
)
def create_profile(ctx: Context, p: CreateProfile) -> dict:
    workspace = authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    content = validate_profile_content({"profile": p.profile.model_dump(mode="json")})
    definition = Definition(
        workspace=workspace, kind="workshop_profile", name=p.name, created_by=ctx.user
    )
    authorize_profile_content(ctx.user, definition, content)
    definition.save()
    draft = Draft.objects.create(definition=definition, content=content, updated_by=ctx.user)
    return {"definition_id": str(definition.id), "name": definition.name, **draft_state(draft)}


@operation(
    "workshop_profile.update",
    UpdateProfile,
    summary="Replace profile suggestions on a draft with optimistic state checking.",
    requires_expected_state=True,
    idempotency_scope=profile_scope,
    authorize_replay=authorize_profile_replay,
)
def update_profile(ctx: Context, p: UpdateProfile) -> dict:
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    if draft.definition.kind != "workshop_profile":
        raise NotFound("Workshop profile draft not found.")
    check_state(ctx, draft)
    content = validate_profile_content({"profile": p.profile.model_dump(mode="json")})
    authorize_profile_content(ctx.user, draft.definition, content)
    draft.content = content
    draft.version += 1
    draft.updated_by = ctx.user
    draft.save(update_fields=["content", "version", "updated_by", "updated_at"])
    return {
        "definition_id": str(draft.definition_id),
        "name": draft.definition.name,
        **draft_state(draft),
    }


@operation(
    "workshop_profile.freeze",
    FreezeProfile,
    summary="Freeze exact profile suggestions and their stock revision dependency.",
    requires_expected_state=True,
    idempotency_scope=profile_scope,
    authorize_replay=authorize_profile_replay,
)
def freeze_profile(ctx: Context, p: FreezeProfile) -> dict:
    from specmate.design.operations import CaptureDraft, freeze_draft

    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE, lock=True)
    if draft.definition.kind != "workshop_profile":
        raise NotFound("Workshop profile draft not found.")
    check_state(ctx, draft)
    if "profile" not in draft.content:
        raise ValidationFailed("A typed workshop profile is required before freezing.")
    profile = WorkshopProfile.model_validate(draft.content["profile"])
    authorize_profile_content(ctx.user, draft.definition, draft.content)
    return freeze_draft(
        ctx, CaptureDraft(draft_id=p.draft_id, dependencies=[profile.stock_revision_id])
    )
