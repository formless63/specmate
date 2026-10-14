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


class ConfigurationAdoption(models.Model):
    """Immutable reviewed change of an owning assembly draft from one resolved configuration.

    Provenance for the draft change: the exact resolved configuration, the selected
    decisions, the reviewed diff and the draft content before and after. The frozen
    target revision is never modified; a new draft or an explicitly selected one is.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    resolved_configuration = models.ForeignKey(
        ResolvedConfiguration, on_delete=models.PROTECT, related_name="adoptions"
    )
    draft = models.ForeignKey("design.Draft", on_delete=models.PROTECT, related_name="+")
    draft_version = models.PositiveIntegerField()
    created_draft = models.BooleanField()
    base_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, null=True, related_name="+"
    )
    option_keys = models.JSONField()
    review = models.JSONField()
    review_canonical = models.BinaryField()
    review_sha256 = models.CharField(max_length=64)
    before_content = models.JSONField()
    before_canonical = models.BinaryField()
    after_content = models.JSONField()
    basis = models.TextField()
    adopted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["draft", "draft_version"], name="configuration_adoption_draft_version"
            ),
            models.CheckConstraint(
                condition=models.Q(draft_version__gte=1)
                & models.Q(review_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(basis__regex=r"\S"),
                name="configuration_adoption_valid",
            ),
        ]
        indexes = [
            models.Index(
                fields=["resolved_configuration", "-created_at"], name="configuration_adoption_rc"
            )
        ]
