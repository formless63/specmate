import uuid

from django.conf import settings
from django.db import models

from specmate.catalog_matching.models import EvidenceRecord


class PassageReview(EvidenceRecord):
    """Append-only review of one exact frozen passive model; it is not qualification."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    model_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="passage_reviews"
    )
    version = models.PositiveIntegerField()
    decision = models.CharField(max_length=20)
    basis = models.TextField()
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(EvidenceRecord.Meta):
        constraints = [
            *EvidenceRecord.Meta.constraints,
            models.UniqueConstraint(
                fields=["model_revision", "version"], name="passage_review_version"
            ),
            models.CheckConstraint(
                condition=models.Q(decision__in=["accepted", "rejected", "needs_evidence"])
                & models.Q(version__gte=1)
                & ~models.Q(basis=""),
                name="passage_review_valid",
            ),
        ]
