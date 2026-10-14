import uuid

from django.conf import settings
from django.db import models


class ResolvedConfiguration(models.Model):
    """Immutable resolved snapshot a build consumes instead of mutable option defaults.

    The design snapshot pins every exact revision; the canonical resolution records each
    decision, its source (selected/default/none) and every unresolved choice.
    """

    class Status(models.TextChoices):
        COMPLETE = "complete"
        INCOMPLETE = "incomplete"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    draft = models.ForeignKey("design.Draft", on_delete=models.PROTECT, related_name="+")
    draft_version = models.PositiveIntegerField()
    snapshot = models.OneToOneField(
        "design.Snapshot", on_delete=models.PROTECT, related_name="resolved_configuration"
    )
    option_set_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    status = models.CharField(max_length=20, choices=Status.choices)
    resolution = models.JSONField()
    resolution_canonical = models.BinaryField()
    resolution_sha256 = models.CharField(max_length=64)
    review_sha256 = models.CharField(max_length=64)
    basis = models.TextField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["complete", "incomplete"])
                & models.Q(draft_version__gte=1)
                & models.Q(resolution_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(review_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(basis__regex=r"\S"),
                name="resolved_configuration_valid",
            )
        ]
        indexes = [models.Index(fields=["draft", "-created_at"], name="resolved_config_draft")]
