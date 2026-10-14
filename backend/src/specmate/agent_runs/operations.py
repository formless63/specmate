"""Agent run lifecycle. Every agent edit is a normal operation executed as the sponsor,
capped to the run's grant and recorded with its exact record-level changes."""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models import Max
from django.utils import timezone

from specmate.access.models import WorkspaceMember
from specmate.access.permissions import (
    Perm,
    authorize,
    authorize_item,
    context_project,
    delegated,
    held_permissions,
    membership,
)
from specmate.agent_runs import capture, discard, grants, queries
from specmate.agent_runs.contracts import (
    ActInRun,
    CheckpointRun,
    CreateRun,
    ListRuns,
    ProposeInRun,
    ReadRun,
    ResumeRun,
    RevertChange,
    ReviewRun,
    StopRun,
)
from specmate.agent_runs.models import AgentRun, AgentRunStep
from specmate.design.models import Definition, Draft
from specmate.operations import (
    Conflict,
    Context,
    IdempotencyMismatch,
    NotFound,
    OperationError,
    PermissionDenied,
    Unsupported,
    ValidationFailed,
    execute,
    operation,
    registry,
)
from specmate.operations.scope import has_scope_policy, workspace_scope

MAX_RUN_LENGTH = timedelta(days=30)
# Failures raised before any effect (invalid payload or preconditions) do not use budget.
UNCHARGED_ERRORS = frozenset({ValidationFailed.code})
Status = AgentRun.Status
STOPPED = {Status.PAUSED, Status.EXHAUSTED, Status.EXPIRED}
TERMINAL = {Status.COMPLETED, Status.CANCELLED}


def _locked_run(ctx: Context, run_id, perm: Perm = Perm.WORKSPACE_READ) -> AgentRun:
    run = (
        AgentRun.objects.select_for_update(of=("self",))
        .select_related("sponsor", "agent")
        .filter(id=run_id)
        .first()
    )
    if run is None or membership(ctx.user, run.workspace_id) is None:
        raise NotFound("Agent run not found.")
    authorize(ctx.user, run.workspace_id, perm)
    _settle(run)
    return run


def _settle(run: AgentRun) -> None:
    """Persist a passed deadline: an active run stops at it."""
    if run.status == Status.ACTIVE and timezone.now() >= run.deadline:
        run.status = Status.EXPIRED
        run.status_reason = "deadline passed"
        _save(run)


def _save(run: AgentRun) -> None:
    run.version += 1
    run.save()


def _append(run: AgentRun, ctx: Context, kind: str, outcome: str, **fields) -> AgentRunStep:
    last = run.steps.aggregate(last=Max("number"))["last"] or 0
    return AgentRunStep.objects.create(
        run=run,
        number=last + 1,
        kind=kind,
        outcome=outcome,
        actor=ctx.user,
        request_id=ctx.request_id[:128],
        **fields,
    )


def _is_party(ctx: Context, run: AgentRun) -> bool:
    return ctx.user.pk in {run.agent_id, run.sponsor_id}


def _require_sponsor(ctx: Context, run: AgentRun) -> None:
    if ctx.user.pk != run.sponsor_id:
        raise PermissionDenied("Only the run's sponsor may change its grant or resume it.")


def _check_deadline(deadline) -> None:
    now = timezone.now()
    if deadline <= now:
        raise ValidationFailed("The deadline must be in the future.")
    if deadline > now + MAX_RUN_LENGTH:
        raise ValidationFailed("A run deadline may be at most 30 days ahead.")


def _fingerprint(p: ActInRun) -> str:
    material = {"operation": p.operation, "payload": p.payload, "expected_state": p.expected_state}
    if p.idempotency_key is not None:
        material["idempotency_key"] = p.idempotency_key
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _step_key(run: AgentRun, p: ActInRun, spec) -> str | None:
    """The inner idempotency key: explicit, or derived from the run and step_key."""
    if p.idempotency_key is not None:
        if not has_scope_policy(spec):
            raise ValidationFailed(f"{p.operation} does not accept an idempotency key.")
        return p.idempotency_key
    if not has_scope_policy(spec):
        return None
    digest = hashlib.sha256(f"{run.id}:{p.step_key}".encode()).hexdigest()
    return f"agent-run-{digest}"


def _result(run: AgentRun, step: AgentRunStep | None = None, *, replayed: bool = False) -> dict:
    out = {"run": queries.run_summary(run)}
    if step is not None:
        out["step"] = queries.step_row(step)
        out["replayed"] = replayed
    return out


# ---- create -------------------------------------------------------------------------


def _create_scope(ctx: Context, p: CreateRun) -> str:
    return workspace_scope(ctx, p.workspace_id, Perm.ITEM_CREATE)


def _create_replay(ctx: Context, p: CreateRun, stored: dict) -> None:
    authorize(ctx.user, p.workspace_id, Perm.ITEM_CREATE)
    run = AgentRun.objects.filter(id=stored["run"]["run_id"], workspace_id=p.workspace_id).first()
    if run is None or run.sponsor_id != ctx.user.pk:
        raise NotFound("Agent run not found.")


@operation(
    "agent_run.create",
    CreateRun,
    summary="Grant an agent account a bounded, draft-level run on your behalf.",
    idempotency_scope=_create_scope,
    authorize_replay=_create_replay,
    access=Perm.ITEM_CREATE,
)
def create(ctx: Context, p: CreateRun) -> dict:
    workspace = authorize(ctx.user, p.workspace_id, Perm.ITEM_CREATE)
    project = context_project(p.project_id, workspace)
    held = held_permissions(ctx.user, workspace.id)
    allowed, boundary = grants.validate_grant(p.allowed_actions, p.boundary_actions, held)
    _check_deadline(p.deadline)
    if p.checkpoint_every is not None and p.checkpoint_every > p.max_actions:
        raise ValidationFailed("checkpoint_every cannot exceed max_actions.")
    agent = ctx.user
    if p.agent_username is not None:
        row = (
            WorkspaceMember.objects.select_related("user")
            .filter(workspace=workspace, user__username=p.agent_username, user__is_active=True)
            .first()
        )
        if row is None:
            raise NotFound("Agent account is not a member of this workspace.")
        agent = row.user
    run = AgentRun.objects.create(
        workspace=workspace,
        project=project,
        title=p.title,
        purpose=p.purpose,
        sponsor=ctx.user,
        agent=agent,
        allowed_actions=allowed,
        boundary_actions=boundary,
        max_actions=p.max_actions,
        deadline=p.deadline,
        checkpoint_every=p.checkpoint_every,
    )
    _append(run, ctx, AgentRunStep.Kind.LIFECYCLE, "created", note=p.purpose)
    return _result(run)


# ---- act ----------------------------------------------------------------------------


@operation(
    "agent_run.act",
    ActInRun,
    summary=(
        "Call one granted operation inside a run, as its sponsor and capped to the grant; "
        "a step_key replays its recorded result."
    ),
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def act(ctx: Context, p: ActInRun) -> dict:
    run = _locked_run(ctx, p.run_id)
    if not _is_party(ctx, run):
        raise PermissionDenied("Only the run's agent account or sponsor may act in it.")
    fingerprint = _fingerprint(p)
    prior = run.steps.filter(step_key=p.step_key).first()
    if prior is not None:
        if prior.fingerprint != fingerprint:
            raise IdempotencyMismatch("This step key was used with a different request.")
        # The recorded outcome is returned as-is: no budget, no repeated effect.
        return _result(run, prior, replayed=True)
    if run.status != Status.ACTIVE:
        raise Conflict(
            f"The run is {run.status}; it does not accept actions.",
            details={"run": queries.run_summary(run)},
        )
    spec = registry.get(p.operation)
    if spec is None:
        raise Unsupported(f"Unknown operation {p.operation!r}.")
    if grants.not_grantable_reason(spec):
        raise PermissionDenied("This operation cannot be used inside an agent run.")
    granted = p.operation in run.allowed_actions or p.operation in run.boundary_actions
    if not granted:
        boundary = grants.boundary_reason(spec)
        if boundary is None:
            raise PermissionDenied("This operation is not among the run's allowed actions.")
        # Stop at the ungranted boundary; the attempt stays visible for review.
        step = _append(
            run,
            ctx,
            AgentRunStep.Kind.BOUNDARY,
            "blocked",
            step_key=p.step_key,
            fingerprint=fingerprint,
            operation=p.operation,
            payload=p.payload,
            expected_state=p.expected_state,
            note=p.note or f"Stopped before {p.operation}: {boundary}.",
            on_behalf_of=run.sponsor,
        )
        run.status = Status.PAUSED
        run.status_reason = f"boundary: {p.operation} ({boundary})"
        _save(run)
        return _result(run, step)

    sponsor = get_user_model().objects.filter(pk=run.sponsor_id, is_active=True).first()
    if sponsor is None or membership(sponsor, run.workspace_id) is None:
        raise PermissionDenied("The run's sponsor no longer holds authority in this workspace.")
    held = held_permissions(sponsor, run.workspace_id)
    if spec.access.permission not in held:
        raise PermissionDenied(f"The sponsor no longer holds {spec.access.permission.value}.")
    cap = grants.delegated_permissions(held, run.boundary_actions)
    inner = Context(
        user=sponsor,
        via=ctx.via,
        request_id=ctx.request_id,
        idempotency_key=_step_key(run, p, spec),
        expected_state=p.expected_state,
    )
    result = error = None
    changes: list[dict] = []
    truncated = False
    charged = True
    with delegated(sponsor.pk, run.workspace_id, cap), capture.capture() as recorder:
        try:
            outcome = execute(p.operation, inner, p.payload)
        except OperationError as exc:
            error = exc.as_dict()
            # The inner operation rolled back: a validation failure changed nothing.
            charged = exc.code not in UNCHARGED_ERRORS
        else:
            result = outcome.result
            changes = recorder.changes()
            truncated = recorder.truncated
            # Replaying a recorded effect (same idempotency key) repeats nothing.
            charged = not outcome.replayed
    step = _append(
        run,
        ctx,
        AgentRunStep.Kind.ACTION,
        "applied" if error is None else "failed",
        step_key=p.step_key,
        fingerprint=fingerprint,
        operation=p.operation,
        payload=p.payload,
        expected_state=p.expected_state,
        result=result,
        error=error,
        changes=changes + ([{"truncated": True}] if truncated else []),
        note=p.note,
        budget_consumed=1 if charged else 0,
        on_behalf_of=sponsor,
    )
    if charged:
        run.actions_used += 1
    if error is None and charged:
        run.actions_since_checkpoint += 1
    if run.actions_used >= run.max_actions:
        run.status = Status.EXHAUSTED
        run.status_reason = "action budget used"
    elif run.checkpoint_every and run.actions_since_checkpoint >= run.checkpoint_every:
        run.status = Status.PAUSED
        run.status_reason = f"checkpoint after {run.checkpoint_every} applied actions"
        _append(run, ctx, AgentRunStep.Kind.CHECKPOINT, "automatic", note=run.status_reason)
        run.actions_since_checkpoint = 0
    _save(run)
    return _result(run, step)


# ---- proposals and checkpoints ------------------------------------------------------


@operation(
    "agent_run.propose",
    ProposeInRun,
    summary="Record a proposal in a run without executing it.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def propose(ctx: Context, p: ProposeInRun) -> dict:
    run = _locked_run(ctx, p.run_id)
    if not _is_party(ctx, run):
        raise PermissionDenied("Only the run's agent account or sponsor may propose in it.")
    if run.status in TERMINAL:
        raise Conflict(f"The run is {run.status}.")
    if p.operation is not None and registry.get(p.operation) is None:
        raise Unsupported(f"Unknown operation {p.operation!r}.")
    step = _append(
        run,
        ctx,
        AgentRunStep.Kind.PROPOSAL,
        "recorded",
        operation=p.operation or "",
        payload=p.payload,
        note=p.summary,
    )
    _save(run)
    return _result(run, step)


@operation(
    "agent_run.checkpoint",
    CheckpointRun,
    summary="Record a checkpoint in a run, optionally pausing it for human review.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def checkpoint(ctx: Context, p: CheckpointRun) -> dict:
    run = _locked_run(ctx, p.run_id)
    if not _is_party(ctx, run):
        raise PermissionDenied("Only the run's agent account or sponsor may checkpoint it.")
    if run.status in TERMINAL:
        raise Conflict(f"The run is {run.status}.")
    step = _append(run, ctx, AgentRunStep.Kind.CHECKPOINT, "recorded", note=p.note)
    run.actions_since_checkpoint = 0
    if p.pause and run.status == Status.ACTIVE:
        run.status = Status.PAUSED
        run.status_reason = "checkpoint"
    _save(run)
    return _result(run, step)


# ---- lifecycle ----------------------------------------------------------------------


@operation(
    "agent_run.complete",
    StopRun,
    summary="Finish a run and hand its changes over for review.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def complete(ctx: Context, p: StopRun) -> dict:
    run = _locked_run(ctx, p.run_id)
    if not _is_party(ctx, run):
        raise PermissionDenied("Only the run's agent account or sponsor may complete it.")
    if run.status == Status.COMPLETED:
        return _result(run)
    if run.status == Status.CANCELLED:
        raise Conflict("The run was cancelled.")
    run.status = Status.COMPLETED
    run.status_reason = "ready for review"
    _append(run, ctx, AgentRunStep.Kind.LIFECYCLE, "completed", note=p.note)
    _save(run)
    return _result(run)


@operation(
    "agent_run.cancel",
    StopRun,
    summary="Cancel a run; it accepts no further actions. Its changes stay reviewable.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def cancel(ctx: Context, p: StopRun) -> dict:
    run = _locked_run(ctx, p.run_id)
    if ctx.user.pk != run.sponsor_id:
        authorize(ctx.user, run.workspace_id, Perm.WORKSPACE_ADMIN)
    if run.status == Status.CANCELLED:
        return _result(run)
    if run.status == Status.COMPLETED:
        raise Conflict("The run is already completed.")
    run.status = Status.CANCELLED
    run.status_reason = "cancelled"
    _append(run, ctx, AgentRunStep.Kind.LIFECYCLE, "cancelled", note=p.note)
    _save(run)
    return _result(run)


@operation(
    "agent_run.resume",
    ResumeRun,
    summary=(
        "Resume a paused, exhausted or expired run, optionally adding budget, a new deadline "
        "or explicit boundary grants. Prior steps and consumed budget are kept."
    ),
    requires_expected_state=True,
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def resume(ctx: Context, p: ResumeRun) -> dict:
    run = _locked_run(ctx, p.run_id)
    _require_sponsor(ctx, run)
    if ctx.expected_state != run.state_token:
        raise Conflict(
            "The run changed since expected state.",
            details={"expected": ctx.expected_state, "current": queries.run_summary(run)},
        )
    if run.status not in STOPPED:
        raise Conflict(f"A {run.status} run cannot be resumed.")
    held = held_permissions(ctx.user, run.workspace_id)
    boundary = sorted(set(run.boundary_actions) | set(p.grant_boundary_actions))
    allowed, boundary = grants.validate_grant(run.allowed_actions, boundary, held)
    if p.deadline is not None:
        _check_deadline(p.deadline)
        run.deadline = p.deadline
    run.max_actions += p.add_actions
    if run.actions_used >= run.max_actions:
        raise ValidationFailed("The run has no remaining actions; add budget to resume.")
    if timezone.now() >= run.deadline:
        raise ValidationFailed("The run's deadline has passed; set a new deadline to resume.")
    added = sorted(set(boundary) - set(run.boundary_actions))
    run.allowed_actions, run.boundary_actions = allowed, boundary
    run.status = Status.ACTIVE
    run.status_reason = ""
    run.actions_since_checkpoint = 0
    detail = {
        "add_actions": p.add_actions,
        "deadline": run.deadline.isoformat(),
        "granted_boundary_actions": added,
    }
    _append(run, ctx, AgentRunStep.Kind.LIFECYCLE, "resumed", note=p.note, payload=detail)
    _save(run)
    return _result(run)


# ---- review -------------------------------------------------------------------------


def _require_reviewer(ctx: Context, run: AgentRun) -> None:
    if ctx.user.pk == run.agent_id and run.agent_id != run.sponsor_id:
        raise PermissionDenied("The run's agent account cannot review its own run.")


@operation(
    "agent_run.review",
    ReviewRun,
    summary="Record a human review decision on a stopped or completed run.",
    supports_idempotency=False,
    access=Perm.DESIGN_EDIT,
)
def review(ctx: Context, p: ReviewRun) -> dict:
    run = _locked_run(ctx, p.run_id, Perm.DESIGN_EDIT)
    _require_reviewer(ctx, run)
    if run.status == Status.ACTIVE:
        raise Conflict("Stop or complete the run before reviewing it.")
    run.review_decision = p.decision
    run.reviewed_by = ctx.user
    run.reviewed_at = timezone.now()
    run.review_note = p.note
    _append(run, ctx, AgentRunStep.Kind.LIFECYCLE, p.decision, note=p.note)
    _save(run)
    return _result(run)


@operation(
    "agent_run.revert_change",
    RevertChange,
    summary=(
        "Restore one draft to its content before an agent step, through draft.update "
        "(refused if the draft changed after that step), or discard a definition the run "
        "created (refused, with reasons, if anything references it or it has a frozen "
        "revision). Every revert is a step in the run log."
    ),
    supports_idempotency=False,
    access=Perm.DESIGN_EDIT,
)
def revert_change(ctx: Context, p: RevertChange) -> dict:
    run = _locked_run(ctx, p.run_id)
    _require_reviewer(ctx, run)
    step = run.steps.filter(id=p.step_id, kind=AgentRunStep.Kind.ACTION).first()
    if step is None:
        raise NotFound("Run step not found.")
    change = next((c for c in step.changes if c.get("record") == p.record), None)
    if change is None:
        raise NotFound("The step did not change this record.")
    if _already_reverted(run, step, p.record):
        raise Conflict("This change was already reverted.")
    definition_pk = discard.created_definition_pk(step.changes, change)
    if definition_pk is not None:
        return _discard_created(ctx, run, step, p, definition_pk)
    if change["model"] != "design.draft" or change["action"] != "updated":
        raise ValidationFailed(
            "Only draft content updates and definitions the run created can be reverted."
        )
    before, after = change["before"], change["after"]
    changes = {
        k: v
        for k, v in before["content"].items()
        if after["content"].get(k, None) != v or k not in after["content"]
    }
    remove = sorted(set(after["content"]) - set(before["content"]))
    inner = Context(
        user=ctx.user,
        via=ctx.via,
        request_id=ctx.request_id,
        expected_state=f"draft-v{after['version']}",
    )
    with capture.capture() as recorder:
        result = execute(
            "draft.update", inner, {"draft_id": change["pk"], "changes": changes, "remove": remove}
        ).result
    reverted = _append(
        run,
        ctx,
        AgentRunStep.Kind.REVERT,
        "applied",
        operation="draft.update",
        payload={"reverts_step": step.number, "record": p.record},
        expected_state=inner.expected_state,
        result=result,
        changes=recorder.changes(),
    )
    _save(run)
    return _result(run, reverted)


def _already_reverted(run: AgentRun, step: AgentRunStep, record: str) -> bool:
    for revert in run.steps.filter(kind=AgentRunStep.Kind.REVERT):
        payload = revert.payload or {}
        if payload.get("reverts_step") == step.number and record in (
            payload.get("records") or [payload.get("record")]
        ):
            return True
    return False


def _discard_created(ctx: Context, run: AgentRun, step: AgentRunStep, p, definition_pk: str):
    """Discard a definition and drafts the run created, only if nothing depends on them."""
    definition = Definition.objects.select_for_update(of=("self",)).filter(pk=definition_pk).first()
    if definition is None:
        raise Conflict("The record no longer exists.")
    if definition.workspace_id != run.workspace_id:
        raise NotFound("Run step not found.")
    authorize_item(ctx.user, definition, Perm.DESIGN_EDIT)
    blockers = discard.blockers(definition)
    if blockers:
        raise Conflict(
            "This record cannot be reverted: " + "; ".join(b["reason"] for b in blockers) + ".",
            details={"blockers": blockers},
        )
    records = discard.records_of(definition)
    with capture.capture() as recorder:
        Draft.objects.filter(definition=definition).delete()
        definition.delete()
    reverted = _append(
        run,
        ctx,
        AgentRunStep.Kind.REVERT,
        "applied",
        operation="agent_run.revert_change",
        payload={
            "reverts_step": step.number,
            "record": p.record,
            "records": records,
            "discarded": True,
        },
        result={"discarded": records},
        changes=recorder.changes(),
    )
    _save(run)
    return _result(run, reverted)


# ---- reads --------------------------------------------------------------------------


@operation(
    "agent_run.list",
    ListRuns,
    summary="List agent runs of a workspace.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def list_runs(ctx: Context, p: ListRuns) -> dict:
    return queries.list_runs(ctx.user, p)


@operation(
    "agent_run.read",
    ReadRun,
    summary="Read one agent run with its grant, budget and complete step log.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read(ctx: Context, p: ReadRun) -> dict:
    return queries.read_run(ctx.user, p.run_id)


@operation(
    "agent_run.review_package",
    ReadRun,
    summary="Prepare a run's review package: every change with diffs, provenance and drift.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def review_package(ctx: Context, p: ReadRun) -> dict:
    return queries.review_package(ctx.user, p.run_id)
