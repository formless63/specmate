import uuid

from django.conf import settings
from django.db import models


class FirmwareAdoption(models.Model):
    """Immutable reviewed declaration change, independent of later owning draft edits."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    draft = models.ForeignKey("design.Draft", on_delete=models.PROTECT)
    draft_version = models.PositiveIntegerField()
    base_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, null=True, related_name="+"
    )
    firmware_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, null=True, related_name="+"
    )
    path = models.JSONField()
    review_sha256 = models.CharField(max_length=64)
    review = models.JSONField()
    review_canonical = models.BinaryField()
    before_content = models.JSONField()
    before_canonical = models.BinaryField()
    after_content = models.JSONField()
    basis = models.TextField()
    adopted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["draft", "draft_version"], name="firmware_adoption_draft_version"
            ),
            models.CheckConstraint(
                condition=models.Q(draft_version__gte=1) & ~models.Q(basis=""),
                name="firmware_adoption_valid",
            ),
        ]
