"""Installation work control: the persisted safe-stop state and its append-only history."""

import uuid

from django.conf import settings
from django.db import models


class WorkControl(models.Model):
    """Singleton. Absent row or `running` accepts work; the others refuse new requests."""

    class Mode(models.TextChoices):
        RUNNING = "running"
        DRAINING = "draining"  # accepted work finishes; nothing new is accepted
        INTERRUPTING = "interrupting"  # unstarted work cancelled; active work asked to stop

    singleton = models.BooleanField(primary_key=True, default=True)
    mode = models.CharField(max_length=16, choices=Mode.choices, default=Mode.RUNNING)
    version = models.PositiveIntegerField(default=1)
    reason = models.CharField(max_length=200, blank=True)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    changed_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(singleton=True), name="work_control_singleton"
            ),
            models.CheckConstraint(
                condition=models.Q(mode__in=["running", "draining", "interrupting"]),
                name="work_control_mode",
            ),
            models.CheckConstraint(
                condition=models.Q(mode="running")
                | (models.Q(changed_at__isnull=False) & models.Q(changed_by__isnull=False)),
                name="work_control_change_attributed",
            ),
        ]


class WorkControlEvent(models.Model):
    """Immutable record of each transition, with honest counts of what it touched."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    from_mode = models.CharField(max_length=16)
    to_mode = models.CharField(max_length=16)
    reason = models.CharField(max_length=200, blank=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    detail = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
