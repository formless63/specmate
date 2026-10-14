"""Deliberate recovery of interrupted, cancelled and failed builds, plus retained history.

Nothing here restarts a tool or rewrites a receipt. A stage whose runner can no longer
reconcile it is resolved as failed with termination unconfirmed, never as cancelled or
succeeded. A retry is a new attempt with a new identity over the same exact source
revision and approved recipe; the earlier attempt and its evidence stay untouched.
"""

from __future__ import annotations

from django.utils import timezone
from pydantic import Field, field_validator

from specmate.access.permissions import Perm, authorize, context_project
from specmate.builds.models import BuildAttempt, BuildStage
from specmate.builds.operations import (
    ACTIVE,
    TERMINAL,
    BuildRef,
    RequestBuild,
    _authorize_compiler_read,
    _create_attempt,
    _event,
    _save,
    _stage_for_build,
    stage_result,
)
from specmate.builds.recipes import approved_recipe
from specmate.operations import Conflict, NotFound, ValidationFailed, operation
from specmate.operations.scope import WorkspaceProjectPayload, workspace_scope
from specmate.sources.models import SourceBundleRevision

# Event details safe for workspace readers; runner identities and fencing tokens are not.
PUBLIC_EVENT_DETAIL = ("reason", "observed", "outcome", "exit_code", "retry_of", "sha256")
MAX_LINEAGE = 100
LIST_LIMIT = 100


def _build_scope(ctx, p) -> str:
    build = BuildAttempt.objects.filter(id=p.build_id).first()
    if build is None:
        raise NotFound("Build not found.")
    return workspace_scope(ctx, build.workspace_id)


def _controls(ctx, stage: BuildStage) -> None:
    """Whoever requested a build may cancel or resolve it; anyone else needs execution authority."""
    authorize(ctx.user, stage.build.workspace_id, Perm.WORKSPACE_READ)
    if ctx.user.pk != stage.build.requested_by_id:
        authorize(ctx.user, stage.build.workspace_id, Perm.BUILD_EXECUTE)


def _runner_unavailable(stage: BuildStage) -> bool:
    runner = stage.runner
    return runner is not None and (
        runner.revoked_at is not None or runner.expires_at <= timezone.now()
    )


def _retry_of(build: BuildAttempt) -> BuildAttempt | None:
    return BuildAttempt.objects.filter(retry_of=build).first()


def _check_state(ctx, stage: BuildStage) -> None:
    if ctx.expected_state != stage_result(stage)["state_token"]:
        raise Conflict("Build changed since expected state.", details=stage_result(stage))


class AbandonBuild(BuildRef):
    basis: str = Field(min_length=1, max_length=500)

    @field_validator("basis")
    @classmethod
    def stated(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A basis is required.")
        return value.strip()


@operation(
    "build.abandon",
    AbandonBuild,
    summary=(
        "Resolve work whose runner credential is gone as failed with termination unconfirmed; "
        "never as cancelled or succeeded."
    ),
    requires_expected_state=True,
    idempotency_scope=_build_scope,
    authorize_replay=lambda ctx, p, stored: _controls(ctx, _stage_for_build(p.build_id)),
    access=Perm.WORKSPACE_READ,
)
def abandon_build(ctx, p: AbandonBuild) -> dict:
    stage = _stage_for_build(p.build_id)
    _controls(ctx, stage)
    _check_state(ctx, stage)
    if stage.state in TERMINAL:
        raise Conflict("Build already has a terminal receipt.", details=stage_result(stage))
    if stage.state not in ACTIVE:
        raise Conflict("Work that never started is cancelled, not abandoned.")
    if not _runner_unavailable(stage):
        raise Conflict(
            "The leasing runner credential is still valid and can reconcile this execution."
        )
    stage.receipt = {
        "outcome": "failed",
        "exit_code": None,
        "outputs": [{"path": o.path, "sha256": o.sha256} for o in stage.outputs.order_by("path")],
        "message": "Resolved without runner confirmation; process termination is unconfirmed.",
        "resolution": "abandoned_unreconciled",
        "termination_confirmed": False,
        "cancellation_requested": stage.cancellation_requested_at is not None,
        "basis": p.basis,
        "resolved_by": ctx.user.pk,
    }
    stage.state = "failed"
    _save(stage)
    _event(stage, "abandoned", reason="runner_unavailable", outcome="failed")
    return {**stage_result(stage), "receipt": stage.receipt}


@operation(
    "build.retry",
    BuildRef,
    summary="Start a new attempt over the exact source revision and recipe of a failed or "
    "cancelled build.",
    requires_expected_state=True,
    status="accepted_async",
    idempotency_scope=_build_scope,
    authorize_replay=lambda ctx, p, stored: _retry_replay(ctx, p, stored),
    access=Perm.BUILD_EXECUTE,
)
def retry_build(ctx, p: BuildRef) -> dict:
    if not ctx.idempotency_key:
        raise ValidationFailed("build.retry requires an idempotency key.")
    stage = _stage_for_build(p.build_id)
    build = stage.build
    authorize(ctx.user, build.workspace_id, Perm.BUILD_EXECUTE)
    _check_state(ctx, stage)
    if stage.state == "succeeded":
        raise ValidationFailed("A succeeded build has nothing to retry.")
    if stage.state not in TERMINAL:
        raise Conflict(
            "The build has no terminal receipt yet; cancel or resolve it before retrying.",
            details=stage_result(stage),
        )
    later = _retry_of(build)
    if later is not None:
        raise Conflict("This build was already retried.", details={"retry_build_id": str(later.id)})
    recipe = approved_recipe(build.recipe_id)
    if recipe.model_dump(mode="json") != build.recipe:
        raise Conflict("The approved recipe changed; request a new build deliberately.")
    source = SourceBundleRevision.objects.filter(
        id=build.source_revision_id, bundle__workspace_id=build.workspace_id
    ).first()
    if source is None:
        raise NotFound("Source revision not found.")
    request = RequestBuild(
        workspace_id=build.workspace_id, source_revision_id=source.id, recipe_id=recipe.id
    )
    result = _create_attempt(ctx, build.workspace, source, recipe, request, retry_of=build)
    return {**result, "retry_of": str(build.id)}


def _retry_replay(ctx, p, stored) -> None:
    previous = BuildAttempt.objects.filter(id=p.build_id).first()
    if previous is None:
        raise NotFound("Build not found.")
    authorize(ctx.user, previous.workspace_id, Perm.BUILD_EXECUTE)
    if not BuildAttempt.objects.filter(id=stored["build_id"], retry_of=previous).exists():
        raise NotFound("Build not found.")


def _lineage(build: BuildAttempt) -> list[dict]:
    chain = [build]
    seen = {build.id}
    node = build
    while node.retry_of_id and len(chain) < MAX_LINEAGE:
        node = BuildAttempt.objects.select_related("stage").get(id=node.retry_of_id)
        if node.id in seen:
            break
        seen.add(node.id)
        chain.insert(0, node)
    node = build
    while len(chain) < MAX_LINEAGE:
        later = BuildAttempt.objects.select_related("stage").filter(retry_of=node).first()
        if later is None or later.id in seen:
            break
        seen.add(later.id)
        chain.append(later)
        node = later
    return [
        {"build_id": str(b.id), "state": b.stage.state, "current": b.id == build.id} for b in chain
    ]


def _actions(stage: BuildStage, retried: bool) -> dict:
    waiting = stage.state == "cancellation_requested"
    return {
        "cancel_available": stage.state not in TERMINAL and stage.cancellation_requested_at is None,
        "retry_available": stage.state in {"failed", "cancelled"} and not retried,
        "abandon_available": stage.state in ACTIVE and _runner_unavailable(stage),
        "awaiting_runner_confirmation": waiting
        or (stage.state == "interrupted" and stage.cancellation_requested_at is not None),
    }


class HistoryRead(BuildRef):
    pass


@operation(
    "build.history",
    HistoryRead,
    summary="Read a build's retained events, partial outputs, receipt and retry lineage.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def history(ctx, p: HistoryRead) -> dict:
    stage = _stage_for_build(p.build_id)
    build = stage.build
    authorize(ctx.user, build.workspace_id, Perm.WORKSPACE_READ)
    _authorize_compiler_read(ctx, stage)
    retried = _retry_of(build)
    return {
        **stage_result(stage),
        "workspace_id": str(build.workspace_id),
        "project_id": str(build.project_id) if build.project_id else None,
        "receipt": stage.receipt,
        "recipe_id": build.recipe_id,
        "source_revision_id": str(build.source_revision_id),
        "configuration": build.configuration_input,
        "requested_at": build.created_at.isoformat(),
        "retry_of": str(build.retry_of_id) if build.retry_of_id else None,
        "retried_by": str(retried.id) if retried else None,
        "requested_by_viewer": ctx.user.pk == build.requested_by_id,
        "lineage": _lineage(build),
        "events": [
            {
                "kind": event.kind,
                "at": event.created_at.isoformat(),
                "detail": {k: v for k, v in event.detail.items() if k in PUBLIC_EVENT_DETAIL},
            }
            for event in stage.events.order_by("id")
        ],
        # Verified bytes of a stage that did not succeed are retained evidence only; they
        # are never an accepted artifact and have no download.
        "outputs": [
            {
                "path": o.path,
                "sha256": o.sha256,
                "size": o.size,
                "accepted": stage.state == "succeeded",
            }
            for o in stage.outputs.order_by("path")
        ],
        **_actions(stage, retried is not None),
    }


class ListBuilds(WorkspaceProjectPayload):
    """Workspace builds; an optional ``project_id`` only filters to that navigation context."""


@operation(
    "build.list",
    ListBuilds,
    summary="List the latest generic builds of a workspace (compiler builds have their own view).",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def list_builds(ctx, p: ListBuilds) -> dict:
    from specmate.firmware_builds.pack import ADAPTER

    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_READ)
    builds = BuildAttempt.objects.filter(workspace=workspace)
    if context_project(p.project_id, workspace) is not None:
        builds = builds.filter(project_id=p.project_id)
    rows = list(
        builds.exclude(recipe_id__startswith=ADAPTER + "-")
        .select_related("stage")
        .order_by("-created_at", "-id")[: LIST_LIMIT + 1]
    )
    return {
        "workspace_id": str(workspace.id),
        "builds": [
            {
                **stage_result(b.stage),
                "recipe_id": b.recipe_id,
                "requested_at": b.created_at.isoformat(),
                "retry_of": str(b.retry_of_id) if b.retry_of_id else None,
                "requested_by_viewer": ctx.user.pk == b.requested_by_id,
                "project_id": str(b.project_id) if b.project_id else None,
            }
            for b in rows[:LIST_LIMIT]
        ],
        "truncated": len(rows) > LIST_LIMIT,
    }
