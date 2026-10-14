import uuid

from django.conf import settings
from django.db import models


class RecordedResult(models.Model):
    """An explicitly recorded, immutable snapshot of a derived result.

    Interface assessments and firmware impact reviews are computed live from exact frozen
    inputs. Recording one stores the result as it was shown, with its exact input pins and
    the recording actor. It is never rewritten: newer input revisions make it stale on read.
    """

    class Source(models.TextChoices):
        INTERFACE_ASSESSMENT = "interface_assessment"
        FIRMWARE_IMPACT = "firmware_impact"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    source = models.CharField(max_length=40, choices=Source.choices)
    # The exact request that produced the result (assessment revision or impact reference).
    request = models.JSONField()
    result = models.JSONField()
    result_sha256 = models.CharField(max_length=64)
    algorithm_version = models.CharField(max_length=80)
    note = models.TextField(blank=True, default="")
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    recorded_at = models.DateTimeField(auto_now_add=True)
    request_id = models.CharField(max_length=200)

    class Meta:
        indexes = [models.Index(fields=["workspace", "-recorded_at"], name="evidence_rec_ws_time")]


class RecordedPin(models.Model):
    """One exact frozen input revision of a recorded result, by role."""

    record = models.ForeignKey(RecordedResult, on_delete=models.PROTECT, related_name="pins")
    role = models.CharField(max_length=80)
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["record", "role", "revision"], name="evidence_recorded_pin_unique"
            )
        ]
