"""Current authority for retained outcomes; never rerun mutating handlers for replay."""

from django.conf import settings

from specmate.access.permissions import Perm, authorize
from specmate.operations import NotFound, PermissionDenied, ValidationFailed


def authorize_builtin_replay(name, ctx, payload, stored):
    if name == "definition.create":
        authorize(ctx.user, payload.scope_id, Perm.ITEM_CREATE)
        from specmate.design.models import Definition
        from specmate.design.operations import authorize_design_content

        definition = Definition.objects.filter(id=stored["definition_id"]).first()
        if definition is None:
            raise NotFound("Definition not found.")
        authorize_design_content(ctx.user, definition, stored["content"])
    elif name in {"draft.update", "draft.snapshot", "draft.freeze"}:
        from specmate.design.models import Revision
        from specmate.design.operations import authorize_design_content, scoped_draft

        permission = Perm.DESIGN_FREEZE if name == "draft.freeze" else Perm.DESIGN_EDIT
        draft = scoped_draft(ctx, payload.draft_id, permission)
        from specmate.design.models import Snapshot
        from specmate.design.operations import authorize_snapshot

        if name == "draft.update":
            authorize_design_content(ctx.user, draft.definition, stored["content"])
        else:
            snapshot = (
                Snapshot.objects.select_related("definition")
                .filter(id=stored["snapshot_id"])
                .first()
            )
            if snapshot is None:
                raise NotFound("Snapshot not found.")
            authorize_snapshot(ctx.user, snapshot)
            if name == "draft.freeze":
                authorize_design_content(ctx.user, draft.definition, stored["draft"]["content"])
        for revision_id in getattr(payload, "dependencies", []):
            revision = Revision.objects.select_related("definition").filter(id=revision_id).first()
            if revision is None:
                raise NotFound("Revision not found.")
            authorize(ctx.user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
    elif name in {"source.register_blob", "source.create_original_bundle"}:
        authorize(ctx.user, payload.scope_id, Perm.SOURCE_REGISTER)
        if name == "source.register_blob":
            _verify_replayed_upload(ctx, payload)
    elif name == "build.request":
        from specmate.builds.models import BuildAttempt
        from specmate.builds.recipes import approved_recipe

        workspace = authorize(ctx.user, payload.scope_id, Perm.BUILD_EXECUTE)
        build = BuildAttempt.objects.filter(
            id=stored["build_id"],
            workspace=workspace,
            source_revision_id=payload.source_revision_id,
            requested_by=ctx.user,
        ).first()
        if build is None:
            raise NotFound("Build not found.")
        if approved_recipe(payload.recipe_id).model_dump(mode="json") != build.recipe:
            raise PermissionDenied("The original execution recipe is no longer approved.")
    elif name == "build.cancel":
        from specmate.builds.operations import _stage_for_build

        stage = _stage_for_build(payload.build_id)
        authorize(ctx.user, stage.build.workspace_id, Perm.WORKSPACE_READ)
        if ctx.user.pk != stage.build.requested_by_id:
            authorize(ctx.user, stage.build.workspace_id, Perm.BUILD_EXECUTE)
    elif name == "runner.revoke":
        from specmate.builds.operations import _operator

        _operator(ctx)
    else:
        # New operations must explicitly declare their scope-aware replay guard.
        raise PermissionDenied("This operation has no current-authorization replay policy.")


def _verify_replayed_upload(ctx, payload):
    from specmate.sources import blobstore

    if payload.size > settings.SPECMATE_MAX_SOURCE_BYTES:
        raise ValidationFailed("Declared size exceeds the configured limit.")
    try:
        staged = blobstore.stage(ctx.attachments["content"], settings.SPECMATE_MAX_SOURCE_BYTES)
    except blobstore.TooLarge:
        raise ValidationFailed("Content exceeds the configured limit.") from None
    try:
        if staged.sha256 != payload.sha256 or staged.size != payload.size:
            raise ValidationFailed("Content does not match the declared hash and size.")
    finally:
        blobstore.discard(staged)
