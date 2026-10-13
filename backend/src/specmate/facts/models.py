import uuid

from django.conf import settings
from django.db import models


class FactSubject(models.Model):
    """A resolved engineering subject with a concurrency token for its assertion ledger."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey("access.Project", on_delete=models.PROTECT)
    kind = models.CharField(max_length=16)
    definition = models.ForeignKey("design.Definition", null=True, on_delete=models.PROTECT)
    revision = models.ForeignKey("design.Revision", null=True, on_delete=models.PROTECT)
    snapshot = models.ForeignKey("design.Snapshot", null=True, on_delete=models.PROTECT)
    physical_unit = models.ForeignKey(
        "physical_units.PhysicalUnit", null=True, on_delete=models.PROTECT
    )
    path = models.JSONField(default=list)
    # NULL denotes the whole subject; it is never an empty feature identifier.
    feature_id = models.CharField(max_length=200, null=True)  # noqa: DJ001
    fingerprint = models.CharField(max_length=64)
    version = models.PositiveIntegerField(default=1)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project", "fingerprint"], name="facts_subject_identity"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        kind="project",
                        definition__isnull=True,
                        revision__isnull=True,
                        snapshot__isnull=True,
                        physical_unit__isnull=True,
                        path=[],
                        feature_id__isnull=True,
                    )
                    | models.Q(
                        kind="definition",
                        definition__isnull=False,
                        revision__isnull=True,
                        snapshot__isnull=True,
                        physical_unit__isnull=True,
                        path=[],
                    )
                    | models.Q(
                        kind="revision",
                        definition__isnull=True,
                        revision__isnull=False,
                        snapshot__isnull=True,
                        physical_unit__isnull=True,
                        path=[],
                    )
                    | (
                        models.Q(
                            kind="occurrence",
                            definition__isnull=True,
                            revision__isnull=True,
                            snapshot__isnull=False,
                            physical_unit__isnull=True,
                        )
                        & ~models.Q(path=[])
                    )
                    | models.Q(
                        kind="physical_unit",
                        definition__isnull=True,
                        revision__isnull=True,
                        snapshot__isnull=True,
                        physical_unit__isnull=False,
                        path=[],
                        feature_id__isnull=True,
                    )
                ),
                name="facts_subject_target",
            ),
        ]

    @property
    def state_token(self):
        return f"facts-v{self.version}"


class FactAssertion(models.Model):
    """Append-only observation; no UPDATE can correct an already recorded assertion."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    subject = models.ForeignKey(FactSubject, on_delete=models.PROTECT, related_name="assertions")
    sequence = models.PositiveIntegerField()
    property = models.CharField(max_length=80)
    status = models.CharField(max_length=20)
    method = models.CharField(max_length=24)
    content = models.JSONField()
    canonical_value = models.JSONField(null=True)
    canonical_conditions = models.JSONField(default=list)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["subject", "sequence"], name="facts_assertion_sequence"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(status="known", canonical_value__isnull=False)
                    | models.Q(
                        status__in=["unknown", "conflicting", "not_applicable", "not_evaluated"],
                        canonical_value__isnull=True,
                    )
                ),
                name="facts_status_value",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    method__in=[
                        "source_observation",
                        "reviewed_association",
                        "calculation",
                        "measurement",
                        "preference",
                    ]
                ),
                name="facts_assertion_method",
            ),
        ]


class AssertionSource(models.Model):
    assertion = models.ForeignKey(
        FactAssertion, on_delete=models.PROTECT, related_name="source_links"
    )
    source_file = models.ForeignKey("sources.SourceBundleFile", on_delete=models.PROTECT)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["assertion", "source_file"], name="facts_assertion_source"
            )
        ]


class AssertionInput(models.Model):
    assertion = models.ForeignKey(
        FactAssertion, on_delete=models.PROTECT, related_name="input_links"
    )
    input_assertion = models.ForeignKey(FactAssertion, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["assertion", "input_assertion"], name="facts_assertion_input"
            )
        ]
