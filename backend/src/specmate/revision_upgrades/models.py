import uuid

from django.conf import settings
from django.db import models

from specmate.catalog_matching.models import EvidenceRecord


class UpgradeProposal(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owning_snapshot = models.ForeignKey("design.Snapshot", on_delete=models.PROTECT)
    old_revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    candidate_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    paths = models.JSONField()
    basis = models.TextField()
    proposed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class UpgradeReview(EvidenceRecord):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    proposal = models.ForeignKey(UpgradeProposal, on_delete=models.PROTECT, related_name="reviews")
    version = models.PositiveIntegerField()
    decision = models.CharField(max_length=20)
    basis = models.TextField()
    features = models.JSONField(default=list)
    impacts = models.JSONField()
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(EvidenceRecord.Meta):
        constraints = [
            *EvidenceRecord.Meta.constraints,
            models.UniqueConstraint(fields=["proposal", "version"], name="upgrade_review_version"),
            models.CheckConstraint(
                condition=models.Q(decision__in=["accepted", "rejected", "needs_evidence"])
                & models.Q(version__gte=1)
                & ~models.Q(basis=""),
                name="upgrade_review_valid",
            ),
        ]


class UpgradeApplication(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    proposal = models.ForeignKey(
        UpgradeProposal, on_delete=models.PROTECT, related_name="applications"
    )
    review = models.ForeignKey(UpgradeReview, on_delete=models.PROTECT)
    draft = models.ForeignKey("design.Draft", on_delete=models.PROTECT)
    draft_version = models.PositiveIntegerField()
    applied_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
