"""Diagnostics reads and safe-stop/reconcile commands over the shared operation layer.

Reads are scoped to a workspace the actor can read, or to the installation operator.
Commands never fabricate a result: an active stage keeps an honest state until its own
runner reports, and nothing interrupted is automatically restarted.
"""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from django.utils import timezone
from pydantic import BaseModel, ConfigDict, Field

from specmate.access.permissions import Perm, authorize, held_permissions
from specmate.builds.models import BuildStage, RunnerCredential
from specmate.builds.operations import _cancel, _expire, _operator
from specmate.diagnostics import checks
from specmate.diagnostics.models import WorkControl, WorkControlEvent
from specmate.operations import Conflict, Context, operation
from specmate.operations.core import ACCESS_OPERATOR
from specmate.operations.scope import GLOBAL_SCOPE

PENDING = checks.PENDING_STATES
LISTED_BUILDS = 20


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _global_scope(ctx, _payload) -> str:
    _operator(ctx)
    return GLOBAL_SCOPE


def _replay_operator(ctx, _payload, _stored) -> None:
    _operator(ctx)


class WorkspaceRef(Payload):
    workspace_id: UUID


@operation(
    "diagnostics.workspace_status",
    WorkspaceRef,
    summary="Read job queue, runner, tool and storage state for one readable workspace.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def workspace_status(ctx: Context, p: WorkspaceRef) -> dict[str, Any]:
    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_READ)
    can_execute = Perm.BUILD_EXECUTE in held_permissions(ctx.user, workspace.id)
    ids = [workspace.id]
    mode = checks.work_mode()
    storage = checks.storage(ids, detail=False)
    queue = checks.queue(ids)
    runner = checks.runner(ids, queue)
    tool_states = checks.tools(ids)
    engine = checks.temporal_probe()
    now = timezone.now()
    stages = (
        BuildStage.objects.filter(
            build__workspace=workspace, state__in=PENDING + checks.ACTIVE_STATES
        )
        .select_related("build")
        .order_by("created_at")[:LISTED_BUILDS]
    )
    builds = [
        {
            "build_id": str(s.build_id),
            "recipe_id": s.build.recipe_id,
            "state": s.state,
            "state_token": f"stage-v{s.version}",
            "cancellation_requested": s.cancellation_requested_at is not None,
            "lease_expired": s.lease_expires_at is not None and s.lease_expires_at <= now,
        }
        for s in stages
    ]
    # Counts across workspaces would leak work elsewhere, so the user view omits the
    # installation-wide queue and reports only this workspace's.
    return {
        "workspace_id": str(workspace.id),
        "evaluated_at": now.isoformat(),
        "work": {k: mode[k] for k in ("mode", "accepting_new_work", "reason", "state_token")},
        "queue": {k: queue[k] for k in ("states", "pending", "active", "oldest_pending_seconds")},
        "dispatch": {
            "undelivered": queue["undelivered"],
            "oldest_undelivered_seconds": queue["oldest_undelivered_seconds"],
        },
        "runner": {
            k: runner[k]
            for k in ("state", "credentials_usable", "stages_holding_lease", "stages_lease_expired")
        },
        "tools": tool_states,
        "storage": {k: storage[k] for k in ("state", "code", "sampled", "missing") if k in storage},
        "workflow_engine": engine,
        "builds": builds,
        "can_execute": can_execute,
        "findings": checks.findings(
            ids,
            "user",
            storage_state=storage,
            queue_state=queue,
            runner_state=runner,
            tool_states=tool_states,
            mode=mode,
            can_execute=can_execute,
            engine_state=engine,
        ),
    }


class NoPayload(Payload):
    pass


@operation(
    "diagnostics.installation",
    NoPayload,
    summary="Operator diagnostics across the installation, with distinct recovery paths.",
    supports_idempotency=False,
    access=ACCESS_OPERATOR,
)
def installation_report(ctx: Context, p: NoPayload) -> dict[str, Any]:
    _operator(ctx)
    from django.conf import settings

    from specmate.operations.startup import schema_ready

    mode = checks.work_mode()
    storage = checks.storage(None, detail=True)
    queue = checks.queue(None)
    runner = checks.runner(None, queue)
    tool_states = checks.tools(None)
    ready = schema_ready()
    engine = checks.temporal_probe()
    found = checks.findings(
        None,
        "operator",
        storage_state=storage,
        queue_state=queue,
        runner_state=runner,
        tool_states=tool_states,
        mode=mode,
        engine_state=engine,
    )
    if not ready:
        found.append(checks.finding("schema_not_ready", "operator"))
    now = timezone.now()
    return {
        "evaluated_at": now.isoformat(),
        "database": {"reachable": True},
        "schema": {"ready": ready},
        "work": mode,
        "queue": queue,
        "runner": runner,
        "tools": tool_states,
        "approved_recipes": [
            {"id": rid, "image": (raw or {}).get("image")}
            for rid, raw in sorted(settings.SPECMATE_APPROVED_RECIPES.items())
        ],
        "credentials": [
            {
                "credential_id": str(c.id),
                "workspace_id": str(c.workspace_id),
                "recipe_ids": c.recipe_ids,
                "expires_at": c.expires_at.isoformat(),
                "revoked": c.revoked_at is not None,
                "usable": c.revoked_at is None and c.expires_at > now,
            }
            for c in RunnerCredential.objects.order_by("created_at")[:100]
        ],
        "storage": storage,
        # Connection probe only; workflow histories are in Temporal's operator UI.
        "workflow_engine": engine,
        "findings": found,
    }


class SafeStop(Payload):
    mode: Literal["drain", "interrupt"]
    reason: str = Field(min_length=1, max_length=200)


def _control() -> WorkControl:
    WorkControl.objects.get_or_create(singleton=True, defaults={"version": 0})
    return WorkControl.objects.select_for_update().get(singleton=True)


def _check_state(ctx: Context, control: WorkControl) -> None:
    if ctx.expected_state != f"work-v{control.version}":
        raise Conflict("Work control changed since expected state.", details=_summary(control))


def _summary(control: WorkControl) -> dict[str, Any]:
    return {
        "mode": control.mode,
        "state_token": f"work-v{control.version}",
        "accepting_new_work": control.mode == WorkControl.Mode.RUNNING,
    }


def _open_work() -> dict[str, int]:
    counts: dict[str, int] = {}
    for state in BuildStage.objects.exclude(state__in=checks.TERMINAL_STATES).values_list(
        "state", flat=True
    ):
        counts[state] = counts.get(state, 0) + 1
    return counts


def _transition(control: WorkControl, mode: str, reason: str, actor, detail: dict) -> None:
    WorkControlEvent.objects.create(
        from_mode=control.mode, to_mode=mode, reason=reason, actor=actor, detail=detail
    )
    control.mode = mode
    control.reason = reason if mode != WorkControl.Mode.RUNNING else ""
    control.version += 1
    control.changed_by = actor
    control.changed_at = timezone.now()
    control.save()


@operation(
    "installation.safe_stop",
    SafeStop,
    summary="Stop accepting work, then drain it or explicitly interrupt it, honestly.",
    requires_expected_state=True,
    authorize_replay=_replay_operator,
    idempotency_scope=_global_scope,
    access=ACCESS_OPERATOR,
)
def safe_stop(ctx: Context, p: SafeStop) -> dict[str, Any]:
    _operator(ctx)
    control = _control()
    _check_state(ctx, control)
    target = WorkControl.Mode.DRAINING if p.mode == "drain" else WorkControl.Mode.INTERRUPTING
    if control.mode == WorkControl.Mode.INTERRUPTING and target == WorkControl.Mode.DRAINING:
        raise Conflict(
            "Interruption was already requested; resume work instead of relaxing it.",
            details=_summary(control),
        )
    previous = control.mode
    cancelled = requested = unchanged = 0
    if target == WorkControl.Mode.INTERRUPTING:
        # The control row is locked above, so admissions wait for this commit and then refuse.
        stages = BuildStage.objects.select_for_update().filter(
            state__in=[*PENDING, "leased", "running"]
        )
        for stage in stages:
            was_pending = stage.state in PENDING
            _cancel(stage, "operator_safe_stop")
            if was_pending:
                cancelled += 1
            else:
                requested += 1
        unchanged = BuildStage.objects.filter(
            state__in=["cancellation_requested", "interrupted"]
        ).count()
    if previous != target:
        detail = {
            "cancelled_before_start": cancelled,
            "cancellation_requested": requested,
            "left_unchanged": unchanged,
        }
        _transition(control, target, p.reason, ctx.user, detail)
    open_work = _open_work()
    return {
        **_summary(control),
        "previous_mode": previous,
        "cancelled_before_start": cancelled,
        "cancellation_requested": requested,
        "left_unchanged": unchanged,
        "open_work": open_work,
        # Safe to stop services only when no stage is unfinished or unreconciled.
        "quiescent": not open_work,
        "workflow_engine": checks.temporal_probe(),
    }


class Resume(Payload):
    pass


@operation(
    "installation.resume",
    Resume,
    summary="Accept new work again. Cancelled or interrupted work is not restarted.",
    requires_expected_state=True,
    authorize_replay=_replay_operator,
    idempotency_scope=_global_scope,
    access=ACCESS_OPERATOR,
)
def resume(ctx: Context, p: Resume) -> dict[str, Any]:
    _operator(ctx)
    control = _control()
    _check_state(ctx, control)
    previous = control.mode
    if previous != WorkControl.Mode.RUNNING:
        _transition(control, WorkControl.Mode.RUNNING, "", ctx.user, {})
    return {**_summary(control), "previous_mode": previous}


@operation(
    "installation.reconcile",
    NoPayload,
    summary="Mark lease-expired stages interrupted and report work needing its own runner.",
    supports_idempotency=False,
    access=ACCESS_OPERATOR,
)
def reconcile(ctx: Context, p: NoPayload) -> dict[str, Any]:
    _operator(ctx)
    expired = []
    for stage in BuildStage.objects.select_for_update().filter(
        state__in=["leased", "running", "cancellation_requested"]
    ):
        _expire(stage)
        if stage.state == "interrupted":
            expired.append(str(stage.build_id))
    awaiting = [
        str(b)
        for b in BuildStage.objects.filter(state="interrupted").values_list("build_id", flat=True)
    ]
    queue = checks.queue(None)
    return {
        "newly_interrupted": expired,
        "awaiting_runner_reconciliation": awaiting,
        "requeued": 0,
        "undelivered_dispatch": queue["undelivered"],
        "workflow_engine": checks.temporal_probe(),
    }
