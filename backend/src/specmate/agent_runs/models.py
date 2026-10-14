"""Agent runs are workspace records; their step log is append-only (see migrations)."""

import uuid

from django.conf import settings
from django.db import models


class AgentRun(models.Model):
    """A bounded grant from a human sponsor to an agent account, plus its lifecycle state.

    The grant (allowed actions, boundary actions) is always a subset of what the sponsor
    holds; actions run through the normal operations as the sponsor, capped to the grant.
    """

    class Status(models.TextChoices):
        ACTIVE = "active"
        PAUSED = "paused"
        EXHAUSTED = "exhausted"
        EXPIRED = "expired"
        COMPLETED = "completed"
        CANCELLED = "cancelled"

    class Decision(models.TextChoices):
        ACCEPTED = "accepted"
        CHANGES_REQUESTED = "changes_requested"
        REJECTED = "rejected"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        "access.Workspace", on_delete=models.PROTECT, related_name="agent_runs"
    )
    project = models.ForeignKey(
        "access.Project", null=True, on_delete=models.SET_NULL, related_name="+"
    )
    title = models.CharField(max_length=200)
    purpose = models.TextField(blank=True, default="")
    sponsor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    agent = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    allowed_actions = models.JSONField(default=list)
    boundary_actions = models.JSONField(default=list)
    max_actions = models.PositiveIntegerField()
    actions_used = models.PositiveIntegerField(default=0)
    deadline = models.DateTimeField()
    checkpoint_every = models.PositiveIntegerField(null=True)
    actions_since_checkpoint = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    status_reason = models.CharField(max_length=200, blank=True, default="")
    version = models.PositiveIntegerField(default=1)
    review_decision = models.CharField(  # noqa: DJ001 — no decision is not a decision
        max_length=20, choices=Decision.choices, null=True, default=None
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    reviewed_at = models.DateTimeField(null=True)
    review_note = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(actions_used__lte=models.F("max_actions")),
                name="agent_run_budget_not_exceeded",
            ),
            models.CheckConstraint(
                condition=models.Q(max_actions__gte=1), name="agent_run_positive_budget"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    status__in=[
                        "active",
                        "paused",
                        "exhausted",
                        "expired",
                        "completed",
                        "cancelled",
                    ]
                ),
                name="agent_run_known_status",
            ),
        ]
        indexes = [models.Index(fields=["workspace", "-created_at"])]

    @property
    def state_token(self) -> str:
        return f"agent-run-v{self.version}"


class AgentRunStep(models.Model):
    """One immutable entry of a run's log: an action, proposal, stop, checkpoint or decision."""

    class Kind(models.TextChoices):
        ACTION = "action"
        BOUNDARY = "boundary"
        PROPOSAL = "proposal"
        CHECKPOINT = "checkpoint"
        LIFECYCLE = "lifecycle"
        REVERT = "revert"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(AgentRun, on_delete=models.PROTECT, related_name="steps")
    number = models.PositiveIntegerField()
    kind = models.CharField(max_length=20, choices=Kind.choices)
    outcome = models.CharField(max_length=20)
    step_key = models.CharField(max_length=128, null=True)  # noqa: DJ001 — only actions carry keys
    fingerprint = models.CharField(max_length=64, blank=True, default="")
    operation = models.CharField(max_length=100, blank=True, default="")
    payload = models.JSONField(null=True)
    expected_state = models.CharField(max_length=128, null=True)  # noqa: DJ001 — none was given
    result = models.JSONField(null=True)
    error = models.JSONField(null=True)
    changes = models.JSONField(default=list)
    note = models.TextField(blank=True, default="")
    budget_consumed = models.PositiveIntegerField(default=0)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    on_behalf_of = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    request_id = models.CharField(max_length=128, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["run", "number"], name="agent_run_step_number"),
            models.UniqueConstraint(
                fields=["run", "step_key"],
                condition=models.Q(step_key__isnull=False),
                name="agent_run_step_key",
            ),
            models.CheckConstraint(
                condition=models.Q(budget_consumed__lte=1), name="agent_run_step_budget_unit"
            ),
        ]
        ordering = ["number"]
