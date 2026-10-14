"""Read models for agent runs: summaries, the step log and the review package."""

from __future__ import annotations

import hashlib
import json

from django.apps import apps
from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone

from specmate.access.permissions import Perm, authorize, context_project, membership
from specmate.agent_runs import discard
from specmate.agent_runs.capture import stored_fields
from specmate.agent_runs.models import AgentRun, AgentRunStep
from specmate.design.models import Definition
from specmate.operations import NotFound

LIMITATIONS = [
    "Changes are captured from model saves and deletes made by each operation; bulk "
    "queryset writes are not observed. Every step keeps its exact operation, payload and "
    "result.",
    "Drift compares each record's current stored fields with the values right after the "
    "agent's step; any later change, by anyone, shows as changed.",
    "A review can restore draft content changed by a step, or discard a definition (with its "
    "drafts) that the run created, only when nothing references it and it has no frozen "
    "revision. Other created records stay and are listed for manual review.",
]


def _name(user) -> str | None:
    return user.username if user is not None else None


def effective_status(run: AgentRun) -> str:
    if run.status == AgentRun.Status.ACTIVE and timezone.now() >= run.deadline:
        return AgentRun.Status.EXPIRED
    return run.status


def run_summary(run: AgentRun) -> dict:
    status = effective_status(run)
    return {
        "run_id": str(run.id),
        "workspace_id": str(run.workspace_id),
        "project_id": str(run.project_id) if run.project_id else None,
        "title": run.title,
        "purpose": run.purpose,
        "sponsor": _name(run.sponsor),
        "agent": _name(run.agent),
        "status": status,
        "status_reason": ("deadline passed" if status != run.status else run.status_reason),
        "state": run.state_token,
        "grant": {
            "allowed_actions": list(run.allowed_actions),
            "boundary_actions": list(run.boundary_actions),
        },
        "budget": {
            "max_actions": run.max_actions,
            "actions_used": run.actions_used,
            "actions_remaining": run.max_actions - run.actions_used,
            "checkpoint_every": run.checkpoint_every,
            "actions_since_checkpoint": run.actions_since_checkpoint,
        },
        "deadline": run.deadline.isoformat(),
        "review": {
            "decision": run.review_decision,
            "reviewed_by": _name(run.reviewed_by),
            "reviewed_at": run.reviewed_at.isoformat() if run.reviewed_at else None,
            "note": run.review_note,
        },
        "created_at": run.created_at.isoformat(),
        "updated_at": run.updated_at.isoformat(),
    }


def step_row(step: AgentRunStep) -> dict:
    return {
        "step_id": str(step.id),
        "number": step.number,
        "kind": step.kind,
        "outcome": step.outcome,
        "step_key": step.step_key,
        "operation": step.operation or None,
        "payload": step.payload,
        "expected_state": step.expected_state,
        "result": step.result,
        "error": step.error,
        "changes": step.changes,
        "note": step.note,
        "budget_consumed": step.budget_consumed,
        "actor": _name(step.actor),
        "on_behalf_of": _name(step.on_behalf_of),
        "request_id": step.request_id,
        "created_at": step.created_at.isoformat(),
    }


def _readable_run(user, run_id) -> AgentRun:
    run = (
        AgentRun.objects.select_related("sponsor", "agent", "reviewed_by").filter(id=run_id).first()
    )
    if run is None or membership(user, run.workspace_id) is None:
        raise NotFound("Agent run not found.")
    authorize(user, run.workspace_id, Perm.WORKSPACE_READ)
    return run


def _steps(run: AgentRun):
    return list(run.steps.select_related("actor", "on_behalf_of").order_by("number"))


def list_runs(user, p) -> dict:
    workspace = authorize(user, p.workspace_id, Perm.WORKSPACE_READ)
    query = AgentRun.objects.select_related("sponsor", "agent", "reviewed_by").filter(
        workspace=workspace
    )
    project = context_project(p.project_id, workspace)
    if project is not None:
        query = query.filter(project=project)
    now = timezone.now()
    if p.status == AgentRun.Status.EXPIRED:
        query = query.filter(Q(status="expired") | Q(status="active", deadline__lte=now))
    elif p.status == AgentRun.Status.ACTIVE:
        query = query.filter(status="active", deadline__gt=now)
    elif p.status:
        query = query.filter(status=p.status)
    runs = list(query.order_by("-created_at")[: p.limit])
    return {"workspace_id": str(workspace.id), "runs": [run_summary(run) for run in runs]}


def read_run(user, run_id) -> dict:
    run = _readable_run(user, run_id)
    return {"run": run_summary(run), "steps": [step_row(step) for step in _steps(run)]}


def _value_diff(before, after) -> dict:
    """Top-level key diff for JSON objects; plain before/after otherwise."""
    if isinstance(before, dict) and isinstance(after, dict):
        return {
            "added": {k: after[k] for k in sorted(set(after) - set(before))},
            "removed": {k: before[k] for k in sorted(set(before) - set(after))},
            "changed": {
                k: {"before": before[k], "after": after[k]}
                for k in sorted(set(before) & set(after))
                if before[k] != after[k]
            },
        }
    return {"before": before, "after": after}


class _People:
    """Show references to people by username in review diffs, never by internal key."""

    def __init__(self):
        self.user_model = get_user_model()
        self.names: dict = {}

    def fields(self, label: str) -> frozenset[str]:
        try:
            model = apps.get_model(label)
        except (LookupError, ValueError):
            return frozenset()
        return frozenset(
            f.attname
            for f in model._meta.concrete_fields
            if f.is_relation and f.related_model is self.user_model
        )

    def shown(self, label: str):
        fields = self.fields(label)

        def value(values: dict, field: str):
            raw = values.get(field)
            return self.name(raw) if field in fields else raw

        return value

    def name(self, pk):
        if pk is None:
            return None
        if pk not in self.names:
            user = self.user_model._base_manager.filter(pk=pk).first()
            self.names[pk] = user.get_username() if user else "unknown user"
        return self.names[pk]


def _current(change: dict) -> str:
    try:
        model = apps.get_model(change["model"])
    except (LookupError, ValueError):
        return "unknown"
    current = stored_fields(model, change["pk"])
    if current is None:
        return "missing" if change["after"] is not None else "unchanged_since_step"
    if change["after"] is None:
        return "changed_since_step"
    return "unchanged_since_step" if current == change["after"] else "changed_since_step"


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()


def _revert_options(step: AgentRunStep, change: dict, current: str, is_reverted: bool) -> dict:
    """How a change can be reverted: restore a draft, discard a created definition, or neither."""
    if is_reverted:
        return {"kind": None, "revertible": False, "blockers": []}
    if change["model"] == "design.draft" and change["action"] == "updated":
        return {"kind": "restore", "revertible": current == "unchanged_since_step", "blockers": []}
    pk = discard.created_definition_pk(step.changes, change)
    if pk is None:
        return {"kind": None, "revertible": False, "blockers": []}
    definition = Definition.objects.filter(pk=pk).first()
    if definition is None:
        return {"kind": "discard", "revertible": False, "blockers": []}
    blockers = discard.blockers(definition)
    return {"kind": "discard", "revertible": not blockers, "blockers": blockers}


def review_package(user, run_id) -> dict:
    run = _readable_run(user, run_id)
    steps = _steps(run)
    rows = [step_row(step) for step in steps]
    reverted_pairs = {
        ((s.payload or {}).get("reverts_step"), record)
        for s in steps
        if s.kind == AgentRunStep.Kind.REVERT
        for record in (s.payload or {}).get("records") or [(s.payload or {}).get("record")]
    }
    changes = []
    truncated_steps = []
    people = _People()
    for step in steps:
        if step.kind != AgentRunStep.Kind.ACTION or step.outcome != "applied":
            continue
        for change in step.changes:
            if change.get("truncated"):
                truncated_steps.append(step.number)
                continue
            before, after = change.get("before") or {}, change.get("after") or {}
            shown = people.shown(change["model"])
            current = _current(change)
            is_reverted = (step.number, change["record"]) in reverted_pairs
            revert = _revert_options(step, change, current, is_reverted)
            changes.append(
                {
                    "step_id": str(step.id),
                    "step_number": step.number,
                    "operation": step.operation,
                    "record": change["record"],
                    "model": change["model"],
                    "pk": change["pk"],
                    "action": change["action"],
                    "changed_fields": change["changed_fields"],
                    "diffs": {
                        field: _value_diff(shown(before, field), shown(after, field))
                        for field in change["changed_fields"]
                    },
                    "current": current,
                    "reverted": is_reverted,
                    "revertible": revert["revertible"],
                    "revert": revert,
                    "provenance": {
                        "agent": _name(step.actor),
                        "on_behalf_of": _name(step.on_behalf_of),
                        "step_key": step.step_key,
                        "request_id": step.request_id,
                        "payload": step.payload,
                        "expected_state": step.expected_state,
                        "at": step.created_at.isoformat(),
                    },
                }
            )

    def of(kind, outcome=None):
        return [
            row
            for row in rows
            if row["kind"] == kind and (outcome is None or row["outcome"] == outcome)
        ]

    return {
        "run": run_summary(run),
        "log_sha256": hashlib.sha256(_canonical(rows)).hexdigest(),
        "counts": {
            "steps": len(rows),
            "applied": len(of("action", "applied")),
            "failed": len(of("action", "failed")),
            "boundary_stops": len(of("boundary")),
            "proposals": len(of("proposal")),
            "checkpoints": len(of("checkpoint")),
            "reverts": len(of("revert")),
            "changed_records": len(changes),
        },
        "changes": changes,
        "boundary_stops": of("boundary"),
        "proposals": of("proposal"),
        "failures": of("action", "failed"),
        "checkpoints": of("checkpoint"),
        "reverts": of("revert"),
        "truncated_steps": truncated_steps,
        "limitations": LIMITATIONS,
    }
