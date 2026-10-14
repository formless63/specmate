"""Permanent build evidence and narrow, revocable runner authority."""

import uuid

from django.conf import settings
from django.db import models


class BuildAttempt(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    # Optional project context: navigation and filtering only, never an owner or authority.
    project = models.ForeignKey(
        "access.Project", null=True, on_delete=models.PROTECT, related_name="+"
    )
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    source_revision = models.ForeignKey("sources.SourceBundleRevision", on_delete=models.PROTECT)
    recipe_id = models.CharField(max_length=128)
    recipe = models.JSONField()
    workflow_id = models.CharField(max_length=100, unique=True)
    # A deliberate retry is a new attempt with its own identity; the earlier attempt
    # and its receipts stay untouched. At most one retry may follow a given attempt.
    retry_of = models.ForeignKey(
        "self", null=True, on_delete=models.PROTECT, related_name="retries"
    )
    # Optional exact resolved configuration (CFG-001) the build consumes; the complete
    # build input is retained verbatim as part of the staged inputs and reproducibility
    # record, so later configuration reads can never change what this attempt used.
    resolved_configuration = models.ForeignKey(
        "configurations.ResolvedConfiguration",
        null=True,
        on_delete=models.PROTECT,
        related_name="+",
    )
    configuration_input = models.JSONField(null=True)
    # Exact per-file record (path, hash, size, type, per-file rights) of the staged inputs,
    # retained at request time. Null only for attempts recorded before it existed.
    staged_inputs = models.JSONField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    resolved_configuration__isnull=True, configuration_input__isnull=True
                )
                | models.Q(resolved_configuration__isnull=False, configuration_input__isnull=False),
                name="build_attempt_configuration_pinned",
            ),
            models.CheckConstraint(
                condition=~models.Q(retry_of=models.F("id")), name="build_attempt_not_own_retry"
            ),
            models.UniqueConstraint(
                fields=["retry_of"],
                condition=models.Q(retry_of__isnull=False),
                name="build_attempt_single_retry",
            ),
        ]


class RunnerCredential(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    recipe_ids = models.JSONField()
    token_sha256 = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class BuildStage(models.Model):
    class State(models.TextChoices):
        WAITING_DISPATCH = "waiting_dispatch"
        QUEUED = "queued"
        LEASED = "leased"
        RUNNING = "running"
        CANCELLATION_REQUESTED = "cancellation_requested"
        SUCCEEDED = "succeeded"
        FAILED = "failed"
        CANCELLED = "cancelled"
        INTERRUPTED = "interrupted"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    build = models.OneToOneField(BuildAttempt, on_delete=models.PROTECT, related_name="stage")
    state = models.CharField(max_length=32, choices=State.choices, default=State.WAITING_DISPATCH)
    version = models.PositiveIntegerField(default=1)
    runner = models.ForeignKey(RunnerCredential, null=True, on_delete=models.PROTECT)
    fencing_token = models.UUIDField(null=True)
    lease_expires_at = models.DateTimeField(null=True)
    cancellation_requested_at = models.DateTimeField(null=True)
    receipt = models.JSONField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(runner__isnull=True, fencing_token__isnull=True)
                | models.Q(runner__isnull=False, fencing_token__isnull=False),
                name="build_stage_runner_fence",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    state__in=["succeeded", "failed", "cancelled"], receipt__isnull=False
                )
                | ~models.Q(state__in=["succeeded", "failed", "cancelled"]),
                name="build_stage_terminal_receipt",
            ),
            models.CheckConstraint(
                condition=~models.Q(state="cancelled")
                | models.Q(cancellation_requested_at__isnull=False),
                name="build_stage_cancelled_was_requested",
            ),
        ]


class BuildOutbox(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    build = models.OneToOneField(BuildAttempt, on_delete=models.PROTECT, related_name="outbox")
    delivered_at = models.DateTimeField(null=True)
    delivery_attempts = models.PositiveIntegerField(default=0)
    last_error = models.CharField(max_length=200, blank=True)
    # A restored installation never delivers work captured before the backup: such rows
    # are withheld permanently instead of being marked delivered or silently deleted.
    withheld_at = models.DateTimeField(null=True)
    withheld_reason = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(withheld_at__isnull=True, withheld_reason="")
                | (
                    models.Q(withheld_at__isnull=False, delivered_at__isnull=True)
                    & ~models.Q(withheld_reason="")
                ),
                name="build_outbox_withheld_undelivered",
            ),
        ]


class StageOutput(models.Model):
    """Verified bytes, scoped by the leased stage; not a globally readable hash."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    stage = models.ForeignKey(BuildStage, on_delete=models.PROTECT, related_name="outputs")
    path = models.CharField(max_length=512)
    sha256 = models.CharField(max_length=64)
    size = models.PositiveBigIntegerField()
    media_type = models.CharField(max_length=200)
    rights = models.CharField(max_length=200)
    source_revision = models.ForeignKey("sources.SourceBundleRevision", on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["stage", "path"], name="stage_output_path")]


class StageEvent(models.Model):
    stage = models.ForeignKey(BuildStage, on_delete=models.PROTECT, related_name="events")
    kind = models.CharField(max_length=40)
    detail = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
