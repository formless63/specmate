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


class SubjectTest(models.Model):
    """An immutable record of one physical test and exactly what it was performed on.

    The tested subject is one actual physical unit, or one work batch taken as a whole.
    It never extends to other units of the same design revision, lot or batch. The
    design revision is stored for later applicability review; an optional resolved
    configuration states the exact configuration the subject was tested as.
    """

    class Finding(models.TextChoices):
        CRITERION_MET = "criterion_met"
        CRITERION_NOT_MET = "criterion_not_met"
        INCONCLUSIVE = "inconclusive"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    subject_kind = models.CharField(max_length=20)
    unit = models.ForeignKey(
        "physical_units.PhysicalUnit", null=True, on_delete=models.PROTECT, related_name="+"
    )
    work_batch = models.ForeignKey(
        "inventory.WorkBatch", null=True, on_delete=models.PROTECT, related_name="+"
    )
    # Batch tests only: units actually tested; null is unknown, never zero or all.
    sample_size = models.PositiveIntegerField(null=True)
    design_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    configuration = models.ForeignKey(
        "configurations.ResolvedConfiguration",
        null=True,
        on_delete=models.PROTECT,
        related_name="+",
    )
    test_kind = models.CharField(max_length=80)
    procedure = models.TextField()
    instruments = models.JSONField()
    conditions = models.JSONField()
    criterion = models.TextField()
    finding = models.CharField(max_length=20, choices=Finding.choices)
    value = models.JSONField(null=True)
    summary = models.TextField(blank=True, default="")
    observed_at = models.DateTimeField()
    note = models.TextField(blank=True, default="")
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    recorded_at = models.DateTimeField(auto_now_add=True)
    request_id = models.CharField(max_length=200)

    class Meta:
        indexes = [
            models.Index(fields=["workspace", "-recorded_at"], name="evidence_test_ws_time"),
            models.Index(fields=["unit"], name="evidence_test_unit"),
            models.Index(fields=["work_batch"], name="evidence_test_batch"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(
                        subject_kind="physical_unit",
                        unit__isnull=False,
                        work_batch__isnull=True,
                        sample_size__isnull=True,
                    )
                    | models.Q(
                        subject_kind="work_batch", unit__isnull=True, work_batch__isnull=False
                    )
                ),
                name="evidence_test_one_subject",
            ),
            models.CheckConstraint(
                condition=models.Q(sample_size__isnull=True) | models.Q(sample_size__gt=0),
                name="evidence_test_sample_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    finding__in=["criterion_met", "criterion_not_met", "inconclusive"]
                ),
                name="evidence_test_finding",
            ),
            models.CheckConstraint(
                condition=models.Q(procedure__regex=r"\S") & models.Q(criterion__regex=r"\S"),
                name="evidence_test_described",
            ),
        ]
