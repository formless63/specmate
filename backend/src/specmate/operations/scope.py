"""Server-resolved idempotency namespaces, with current scope checks before lookup.

New domains register an explicit operation hook. The built-in dispatcher only covers
foundation operations; payload fields alone never authorize a namespace.
"""

from uuid import UUID

from specmate.access.permissions import Perm, authorize
from specmate.operations import NotFound, PermissionDenied

GLOBAL_SCOPE = "global"
LEGACY_SCOPE = "legacy"


def project_scope(ctx, project_id, permission=Perm.PROJECT_READ) -> str:
    project = authorize(ctx.user, project_id, permission)
    return f"project:{project.id}"


def revision_scope(ctx, revision_id, permission=Perm.PROJECT_READ) -> str:
    from specmate.design.models import Revision

    revision = Revision.objects.select_related("definition").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Revision not found.")
    return project_scope(ctx, revision.definition.project_id, permission)


def validated_scope(value: str) -> str:
    """Reject missing/ambiguous hook output rather than silently sharing a namespace."""
    if value == GLOBAL_SCOPE:
        return value
    if isinstance(value, str) and value.startswith("project:"):
        try:
            canonical = f"project:{UUID(value.removeprefix('project:'))}"
        except ValueError:
            canonical = None
        if canonical == value:
            return value
    raise PermissionDenied("This operation has no valid idempotency scope policy.")


def builtin_scope(name, ctx, payload) -> str:
    if name == "project.create":
        return GLOBAL_SCOPE
    if name in {
        "definition.create",
        "source.register_blob",
        "source.create_original_bundle",
        "build.request",
    }:
        scope = project_scope(ctx, payload.project_id)
        if name == "definition.create":
            return _authorize_retained_design(name, ctx, payload, scope)
        return scope
    if name in {"draft.update", "draft.snapshot", "draft.freeze"}:
        from specmate.design.operations import scoped_draft

        draft = scoped_draft(ctx, payload.draft_id, Perm.PROJECT_READ)
        scope = f"project:{draft.definition.project_id}"
        return _authorize_retained_design(name, ctx, payload, scope)
    if name == "build.cancel":
        from specmate.builds.models import BuildAttempt

        build = BuildAttempt.objects.filter(id=payload.build_id).first()
        if build is None:
            raise NotFound("Build not found.")
        return project_scope(ctx, build.project_id)
    if name == "runner.revoke":
        from specmate.builds.models import RunnerCredential
        from specmate.builds.operations import _operator

        # Operator revocation deliberately does not require project membership.
        _operator(ctx)
        credential = RunnerCredential.objects.filter(id=payload.credential_id).first()
        if credential is None:
            raise NotFound("Runner not found.")
        return f"project:{credential.project_id}"
    raise PermissionDenied("This operation has no idempotency scope policy.")


def _authorize_retained_design(name, ctx, payload, scope):
    """Protect mechanical and firmware outcomes before generic command fingerprint diagnostics.

    Determine the retained kind from server-owned state: changing the incoming
    create kind or content must not bypass authority over an earlier result.
    Other definition kinds keep their existing generic replay behavior.
    """
    from specmate.design.models import Definition, Draft, Snapshot
    from specmate.operations.models import IdempotencyRecord
    from specmate.operations.replay import authorize_builtin_replay

    records = IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user, operation=name, key=ctx.idempotency_key
    )
    retained = records.filter(scope=scope).first() or records.filter(scope=LEGACY_SCOPE).first()
    if retained is None:
        return scope
    stored = retained.result
    snapshot = None
    retained_draft_id = stored.get("draft_id") or stored.get("draft", {}).get("draft_id")
    if name == "definition.create":
        definition = Definition.objects.filter(id=stored.get("definition_id")).first()
    elif retained_draft_id:
        draft = Draft.objects.select_related("definition").filter(id=retained_draft_id).first()
        definition = draft.definition if draft else None
    else:
        snapshot = (
            Snapshot.objects.select_related("definition")
            .filter(id=stored.get("snapshot_id"))
            .first()
        )
        definition = snapshot.definition if snapshot else None
    if definition is not None and definition.kind in {"mechanical_source", "firmware"}:
        if snapshot is not None:
            from specmate.design.operations import authorize_snapshot

            authorize_snapshot(ctx.user, snapshot)
        retained_payload = (
            payload.model_copy(update={"draft_id": retained_draft_id})
            if retained_draft_id and name != "definition.create"
            else payload
        )
        authorize_builtin_replay(name, ctx, retained_payload, stored)
    return scope
