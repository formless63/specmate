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
        return project_scope(ctx, payload.project_id)
    if name in {"draft.update", "draft.snapshot", "draft.freeze"}:
        from specmate.design.operations import scoped_draft

        draft = scoped_draft(ctx, payload.draft_id, Perm.PROJECT_READ)
        return f"project:{draft.definition.project_id}"
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
