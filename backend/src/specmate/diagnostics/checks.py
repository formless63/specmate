"""Read-only evaluation of tools, storage, authority and evidence freshness.

Each finding names exactly one category with its own recovery path, so an operator or
user never has to guess whether a missing tool, a failing disk, a withdrawn grant or an
out-of-date result is the cause. Nothing here writes, retries or repairs. A check that
cannot be performed is reported as `not_evaluated`, never as healthy.
"""

from __future__ import annotations

import os
import shutil
import socket
from datetime import timedelta
from typing import Any, Literal

from django.conf import settings
from django.db.models import Count, Min, Q
from django.utils import timezone

from specmate.builds.models import (
    BuildOutbox,
    BuildStage,
    RunnerCredential,
    StageEvent,
    StageOutput,
)
from specmate.builds.recipes import approved_recipe
from specmate.diagnostics.models import WorkControl
from specmate.operations import OperationError
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob

Audience = Literal["user", "operator"]

ACTIVE_STATES = ("leased", "running", "cancellation_requested", "interrupted")
PENDING_STATES = ("waiting_dispatch", "queued")
TERMINAL_STATES = ("succeeded", "failed", "cancelled")
SAMPLE = 200
DISPATCH_STALL_SECONDS = 60
DENIAL_WINDOW = timedelta(days=7)
DENIAL_REASONS = {
    "execution_authority_revoked": "execution_authority_withdrawn",
    "runner_revoked": "runner_revoked",
}
DEFAULT_MIN_FREE_BYTES = 512 * 1024**2

# code -> category, severity, summary, user recovery, operator recovery.
CATALOG: dict[str, tuple[str, str, str, str, str]] = {
    "recipe_not_approved": (
        "tool_unavailable",
        "blocking",
        "A requested tool recipe is not approved on this installation.",
        "Your sources and designs are unaffected. Ask the installation operator to approve "
        "the recipe, then request the build again; this one will not run by itself.",
        "Add the digest-pinned recipe to the approved registry, restart app and jobs, "
        "and confirm the runner can load the pinned image.",
    ),
    "recipe_changed": (
        "tool_unavailable",
        "blocking",
        "The approved recipe no longer matches the one this build was requested with.",
        "The build is held to its original tool pin and will not run with a different tool. "
        "Request a new build to use the current tool.",
        "The registry entry was edited after the request. Restore the original pin to let "
        "queued work proceed, or cancel it and request a new build.",
    ),
    "no_runner_enrolled": (
        "tool_unavailable",
        "blocking",
        "Work is waiting but no runner credential is enrolled for this workspace.",
        "Native execution is not enabled here. Stored sources are safe; ask the operator "
        "to enable a runner for this workspace and recipe.",
        "Enroll a scoped credential for the workspace and recipe, then start the optional "
        "runner profile. See the deployment guide for the runner authority boundary.",
    ),
    "storage_root_missing": (
        "storage_failure",
        "blocking",
        "The artifact storage location is missing although stored records refer to it.",
        "Stored files cannot be read right now. Do not re-upload to work around this; "
        "ask the operator to restore storage, then results can be verified again.",
        "Check the artifact volume mount. Do not recreate an empty root: restore the "
        "volume or a backup so existing content addresses resolve.",
    ),
    "storage_root_permission": (
        "storage_failure",
        "blocking",
        "The artifact storage location cannot be read by the application.",
        "Stored files cannot be read right now. Your records are intact; ask the operator "
        "to repair storage access.",
        "The application account cannot access the artifact root. Fix ownership or mode "
        "on the volume; this is a filesystem problem, not a workspace permission.",
    ),
    "storage_read_only": (
        "storage_failure",
        "degraded",
        "Artifact storage is readable but not writable.",
        "You can read stored files, but new uploads and results cannot be saved until the "
        "operator restores write access.",
        "The artifact root is mounted read-only or lacks write permission. Fix the mount "
        "before accepting uploads or runner outputs.",
    ),
    "storage_low_space": (
        "storage_failure",
        "degraded",
        "Artifact storage is nearly full.",
        "New uploads or results may fail soon. Existing content is unaffected; tell the operator.",
        "Free or extend the volume. Retention cleanup is permission-aware and never "
        "deletes original sources.",
    ),
    "storage_blobs_missing": (
        "storage_failure",
        "blocking",
        "Some recorded files are missing or have the wrong size in storage.",
        "Affected files cannot be used or downloaded. Do not treat their records as valid "
        "results; the operator must restore them from backup.",
        "Restore the missing content addresses from backup. Compare the sampled hashes "
        "listed in the evidence; do not regenerate records to hide the loss.",
    ),
    "execution_authority_withdrawn": (
        "permission_denied",
        "attention",
        "Recent builds were cancelled because their execution authority was withdrawn.",
        "The requester or workspace grant no longer allows execution. A workspace "
        "administrator can restore the Native execution grant; then request a new build.",
        "The requesting account lost build execution or was deactivated. Restore the "
        "grant if intended; cancelled work is not resumed.",
    ),
    "runner_revoked": (
        "permission_denied",
        "attention",
        "Recent builds were cancelled because a runner credential was revoked.",
        "Execution was stopped on purpose by the operator. Ask them before requesting a new build.",
        "A revoked credential cancels its active stages. Enroll a new scoped credential "
        "only if execution should resume.",
    ),
    "runner_credential_unusable": (
        "permission_denied",
        "blocking",
        "Every runner credential for this workspace is expired or revoked.",
        "Waiting builds cannot start. Ask the operator to issue a new scoped credential.",
        "Issue a new workspace and recipe scoped credential; expired ones cannot be renewed.",
    ),
    "actor_cannot_execute": (
        "permission_denied",
        "info",
        "Your account can read this workspace but cannot request or cancel native builds.",
        "Ask a workspace administrator for the Native execution grant if you need it.",
        "Not an operator action: grants are managed per workspace by its administrators.",
    ),
    "lease_expired_unreconciled": (
        "stale_evidence",
        "attention",
        "A stage lease expired and its outcome is not yet recorded.",
        "This build's result is not known. It will not be reported as finished or "
        "restarted automatically; wait for the runner to reconcile or request a new build.",
        "Run reconciliation, then check that the runner is up. The original execution can "
        "only be resumed by its own runner with the same fencing token.",
    ),
    "interrupted_awaiting_reconciliation": (
        "stale_evidence",
        "attention",
        "A stage was interrupted and has no accepted receipt.",
        "The outcome of this build is unknown. Do not rely on partial output; request a new "
        "build if the runner does not report back.",
        "Start the owning runner so it observes the original container and reconciles. "
        "Never mark the stage complete by hand.",
    ),
    "dispatch_undelivered": (
        "dispatch_stalled",
        "attention",
        "Accepted builds have not been handed to the workflow engine.",
        "Your request is saved and will start when background processing resumes; it has "
        "not been lost.",
        "Check that the jobs service and Temporal are running. Delivery is at-least-once "
        "and resumes by itself; the engine itself is not queried here.",
    ),
    "workflow_engine_unreachable": (
        "service_unavailable",
        "attention",
        "The workflow engine did not accept a connection.",
        "Accepted builds are saved and will start when background processing resumes; "
        "nothing has been lost. Tell the operator if this persists.",
        "Check that Temporal is running and that TEMPORAL_ADDRESS is correct. This probe "
        "only opens a connection; it does not read workflows or prove the namespace exists.",
    ),
    "installation_draining": (
        "work_paused",
        "info",
        "The installation is draining: accepted work finishes and new work is refused.",
        "New builds cannot be requested until the operator resumes work. Running work continues.",
        "Wait for active stages to finish, then stop the services. Resume with the "
        "work-control command.",
    ),
    "installation_interrupting": (
        "work_paused",
        "attention",
        "The installation is interrupting work: unstarted builds were cancelled and active "
        "ones asked to stop.",
        "New builds are refused. Cancelled builds are not restarted; request them again "
        "after the operator resumes.",
        "Active runners must confirm termination; unconfirmed stages become interrupted "
        "when their lease expires. Do not stop the runner before that is visible.",
    ),
    "installation_maintenance": (
        "work_paused",
        "attention",
        "The installation was restored from a backup and is in maintenance: builds, runner "
        "leases and workflow dispatch are disabled.",
        "Stored designs and sources can be read. Builds that were unfinished when the backup "
        "was taken were cancelled or marked interrupted and will not restart by themselves; "
        "request them again after the operator resumes work.",
        "Check the restore report and diagnostics. Restored runner credentials were revoked: "
        "approve recipes and enroll new scoped credentials deliberately, then resume with "
        "the work-control command.",
    ),
    "schema_not_ready": (
        "service_unavailable",
        "blocking",
        "The application schema is not ready.",
        "The service is starting or failed to start; try again shortly.",
        "Inspect app logs. Never wipe data to recover; fix the migration failure.",
    ),
}


def _split_address(address: str) -> tuple[str, int] | None:
    host, sep, port = address.strip().rpartition(":")
    if not sep:
        host, port = address.strip(), "7233"
    host = host.strip("[]")
    if not host or not port.isdigit() or not 0 < int(port) < 65536:
        return None
    return host, int(port)


def temporal_probe() -> dict[str, Any]:
    """Bounded, read-only reachability probe of the configured Temporal frontend.

    Opens one TCP connection and closes it; no workflow, namespace or history is touched,
    so `reachable` means only that something accepts connections at the address. A name that
    cannot be resolved or an unusable address is `unreachable` or `unknown` with a reason,
    never silently healthy.
    """
    address = str(getattr(settings, "SPECMATE_TEMPORAL_ADDRESS", "") or "")
    timeout = float(getattr(settings, "SPECMATE_TEMPORAL_PROBE_TIMEOUT", 2) or 2)
    target = _split_address(address) if address else None
    if target is None:
        return {"state": "unknown", "reason": "address_not_configured_or_invalid"}
    try:
        with socket.create_connection(target, timeout=timeout):
            pass
    except TimeoutError:
        return {"state": "unreachable", "reason": "connect_timeout"}
    except socket.gaierror:
        return {"state": "unreachable", "reason": "name_not_resolved"}
    except ConnectionRefusedError:
        return {"state": "unreachable", "reason": "connection_refused"}
    except OSError:
        return {"state": "unreachable", "reason": "network_error"}
    return {"state": "reachable", "reason": "connection_accepted"}


def finding(code: str, audience: Audience, **evidence: Any) -> dict[str, Any]:
    category, severity, summary, user, operator = CATALOG[code]
    return {
        "code": code,
        "category": category,
        "severity": severity,
        "summary": summary,
        "recovery": user if audience == "user" else operator,
        "evidence": evidence,
    }


def work_mode() -> dict[str, Any]:
    control = WorkControl.objects.filter(singleton=True).first()
    version = control.version if control else 0
    return {
        "mode": control.mode if control else WorkControl.Mode.RUNNING,
        "accepting_new_work": control is None or control.mode == WorkControl.Mode.RUNNING,
        "reason": control.reason if control else "",
        "state_token": f"work-v{version}",
        "changed_at": control.changed_at.isoformat() if control and control.changed_at else None,
    }


def storage(workspace_ids: list | None, *, detail: bool) -> dict[str, Any]:
    """Probe without writing: root accessibility, free space and a bounded blob sample."""
    blobs = SourceBlob.objects.all()
    outputs = StageOutput.objects.all()
    if workspace_ids is not None:
        blobs = blobs.filter(workspace_id__in=workspace_ids)
        outputs = outputs.filter(stage__build__workspace_id__in=workspace_ids)
    refs = {(r.sha256, r.size) for r in blobs.order_by("-created_at")[:SAMPLE]}
    refs |= {(r.sha256, r.size) for r in outputs.order_by("-created_at")[:SAMPLE]}
    result: dict[str, Any] = {"state": "available", "code": None, "sampled": len(refs)}
    root = blobstore.root()
    try:
        exists = root.is_dir()
    except PermissionError:
        return {**result, "state": "unavailable", "code": "storage_root_permission"}
    except OSError:
        return {**result, "state": "unavailable", "code": "storage_root_missing"}
    if not exists:
        # A fresh installation has stored nothing; that is not a failure, but also not proof.
        if not refs:
            return {**result, "state": "not_initialized", "code": None}
        return {**result, "state": "unavailable", "code": "storage_root_missing"}
    try:
        usage = shutil.disk_usage(root)
    except OSError:
        return {**result, "state": "unavailable", "code": "storage_root_permission"}
    missing = []
    for sha256, size in sorted(refs):
        try:
            if blobstore.blob_path(sha256).stat().st_size != size:
                missing.append(sha256)
        except FileNotFoundError:
            missing.append(sha256)
        except OSError:
            return {**result, "state": "unavailable", "code": "storage_root_permission"}
    result["missing"] = len(missing)
    if detail:
        result["free_bytes"] = usage.free
        result["missing_sha256"] = missing[:10]
    if missing:
        result.update(state="degraded", code="storage_blobs_missing")
    elif not os.access(root, os.W_OK | os.X_OK):
        result.update(state="read_only", code="storage_read_only")
    elif usage.free < getattr(settings, "SPECMATE_MIN_FREE_BYTES", DEFAULT_MIN_FREE_BYTES):
        result.update(state="low_space", code="storage_low_space")
    return result


def _stage_scope(workspace_ids: list | None) -> Q:
    return Q() if workspace_ids is None else Q(build__workspace_id__in=workspace_ids)


def queue(workspace_ids: list | None) -> dict[str, Any]:
    stages = BuildStage.objects.filter(_stage_scope(workspace_ids))
    counts = dict(stages.values_list("state").annotate(n=Count("id")).order_by())
    pending = stages.filter(state__in=PENDING_STATES).aggregate(oldest=Min("created_at"))["oldest"]
    # Rows withheld by a restore are never delivered, so they are not a dispatch backlog.
    outbox = BuildOutbox.objects.filter(delivered_at__isnull=True, withheld_at__isnull=True)
    if workspace_ids is not None:
        outbox = outbox.filter(build__workspace_id__in=workspace_ids)
    oldest_outbox = outbox.aggregate(oldest=Min("created_at"))["oldest"]
    now = timezone.now()
    return {
        "states": counts,
        "pending": sum(counts.get(s, 0) for s in PENDING_STATES),
        "active": sum(counts.get(s, 0) for s in ACTIVE_STATES),
        "oldest_pending_seconds": int((now - pending).total_seconds()) if pending else None,
        "undelivered": outbox.count(),
        "oldest_undelivered_seconds": int((now - oldest_outbox).total_seconds())
        if oldest_outbox
        else None,
        "delivery_error_codes": sorted(
            set(outbox.exclude(last_error="").values_list("last_error", flat=True))
        )[:10],
        "withheld": BuildOutbox.objects.filter(
            withheld_at__isnull=False,
            **({} if workspace_ids is None else {"build__workspace_id__in": workspace_ids}),
        ).count(),
    }


def runner(workspace_ids: list | None, queue_state: dict[str, Any]) -> dict[str, Any]:
    """Runner liveness is observable only while it holds work; idle is not 'online'."""
    now = timezone.now()
    credentials = RunnerCredential.objects.all()
    if workspace_ids is not None:
        credentials = credentials.filter(workspace_id__in=workspace_ids)
    usable = credentials.filter(revoked_at__isnull=True, expires_at__gt=now)
    stages = BuildStage.objects.filter(_stage_scope(workspace_ids), state__in=ACTIVE_STATES)
    holding = stages.filter(lease_expires_at__gt=now).exclude(state="interrupted").count()
    expired = stages.filter(Q(lease_expires_at__lte=now) | Q(state="interrupted")).count()
    if not credentials.exists():
        state = "not_enrolled"
    elif not usable.exists():
        state = "credential_unusable"
    elif holding:
        state = "working"
    elif expired:
        state = "lease_expired"
    else:
        state = "enrolled_liveness_unknown"
    recipes = sorted({r for ids in usable.values_list("recipe_ids", flat=True) for r in ids})
    return {
        "state": state,
        "credentials_total": credentials.count(),
        "credentials_usable": usable.count(),
        "recipe_ids": recipes,
        "stages_holding_lease": holding,
        "stages_lease_expired": expired,
    }


def tools(workspace_ids: list | None) -> list[dict[str, Any]]:
    """Registry state for every recipe that unfinished builds in scope depend on."""
    rows = (
        BuildStage.objects.filter(
            _stage_scope(workspace_ids), state__in=PENDING_STATES + ACTIVE_STATES
        )
        .select_related("build")
        .order_by("created_at")[:SAMPLE]
    )
    seen: dict[str, dict[str, Any]] = {}
    for stage in rows:
        entry = seen.setdefault(
            stage.build.recipe_id,
            {"recipe_id": stage.build.recipe_id, "status": None, "builds": 0},
        )
        entry["builds"] += 1
        try:
            current = approved_recipe(stage.build.recipe_id).model_dump(mode="json")
            entry["status"] = "approved" if current == stage.build.recipe else "changed"
        except OperationError:
            entry["status"] = "not_approved"
    return sorted(seen.values(), key=lambda e: e["recipe_id"])


def _stale(workspace_ids: list | None) -> dict[str, list[str]]:
    now = timezone.now()
    stages = BuildStage.objects.filter(_stage_scope(workspace_ids), state__in=ACTIVE_STATES)
    expired = stages.filter(lease_expires_at__lte=now).exclude(state="interrupted")
    interrupted = stages.filter(state="interrupted")
    return {
        "expired": [str(b) for b in expired.values_list("build_id", flat=True)[:10]],
        "interrupted": [str(b) for b in interrupted.values_list("build_id", flat=True)[:10]],
    }


def _denials(workspace_ids: list | None) -> dict[str, list[str]]:
    events = StageEvent.objects.filter(
        kind="cancellation_requested",
        detail__reason__in=list(DENIAL_REASONS),
        created_at__gte=timezone.now() - DENIAL_WINDOW,
    )
    if workspace_ids is not None:
        events = events.filter(stage__build__workspace_id__in=workspace_ids)
    found: dict[str, list[str]] = {}
    for event in events.select_related("stage").order_by("-created_at")[:SAMPLE]:
        builds = found.setdefault(DENIAL_REASONS[event.detail["reason"]], [])
        if len(builds) < 10:
            builds.append(str(event.stage.build_id))
    return found


def findings(
    workspace_ids: list | None,
    audience: Audience,
    *,
    storage_state: dict[str, Any],
    queue_state: dict[str, Any],
    runner_state: dict[str, Any],
    tool_states: list[dict[str, Any]],
    mode: dict[str, Any],
    can_execute: bool | None = None,
    engine_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if engine_state and engine_state["state"] == "unreachable":
        out.append(finding("workflow_engine_unreachable", audience, reason=engine_state["reason"]))
    if mode["mode"] == WorkControl.Mode.DRAINING:
        out.append(finding("installation_draining", audience))
    elif mode["mode"] == WorkControl.Mode.INTERRUPTING:
        out.append(finding("installation_interrupting", audience))
    elif mode["mode"] == WorkControl.Mode.MAINTENANCE:
        out.append(finding("installation_maintenance", audience))
    for tool in tool_states:
        if tool["status"] == "not_approved":
            out.append(finding("recipe_not_approved", audience, recipe_id=tool["recipe_id"]))
        elif tool["status"] == "changed":
            out.append(finding("recipe_changed", audience, recipe_id=tool["recipe_id"]))
    if queue_state["pending"]:
        if runner_state["state"] == "not_enrolled":
            out.append(finding("no_runner_enrolled", audience, waiting=queue_state["pending"]))
        elif runner_state["state"] == "credential_unusable":
            out.append(
                finding("runner_credential_unusable", audience, waiting=queue_state["pending"])
            )
    if storage_state["code"]:
        evidence = {k: v for k, v in storage_state.items() if k not in {"state", "code"}}
        out.append(finding(storage_state["code"], audience, **evidence))
    for code, builds in _denials(workspace_ids).items():
        out.append(finding(code, audience, build_ids=builds))
    stale = _stale(workspace_ids)
    if stale["expired"]:
        out.append(finding("lease_expired_unreconciled", audience, build_ids=stale["expired"]))
    if stale["interrupted"]:
        out.append(
            finding("interrupted_awaiting_reconciliation", audience, build_ids=stale["interrupted"])
        )
    stalled = queue_state["undelivered"] and (
        queue_state["delivery_error_codes"]
        or (queue_state["oldest_undelivered_seconds"] or 0) > DISPATCH_STALL_SECONDS
    )
    if stalled:
        out.append(
            finding(
                "dispatch_undelivered",
                audience,
                undelivered=queue_state["undelivered"],
                error_codes=queue_state["delivery_error_codes"],
            )
        )
    if can_execute is False:
        out.append(finding("actor_cannot_execute", audience))
    return out
