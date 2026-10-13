import uuid

from django.conf import settings
from django.db import models


class EvidenceRecord(models.Model):
    evidence_status = models.CharField(max_length=30)
    citation = models.TextField(null=True)  # noqa: DJ001 — absent evidence is explicitly unknown
    source_file = models.ForeignKey("sources.SourceBundleFile", null=True, on_delete=models.PROTECT)

    class Meta:
        abstract = True
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    evidence_status="unknown", source_file__isnull=True, citation__isnull=True
                )
                | (
                    models.Q(
                        evidence_status="unverified_citation",
                        source_file__isnull=True,
                        citation__isnull=False,
                    )
                    & ~models.Q(citation="")
                )
                | models.Q(
                    evidence_status="registered_file",
                    source_file__isnull=False,
                    citation__isnull=True,
                ),
                name="%(app_label)s_%(class)s_evidence",
            )
        ]


class MatchCandidate(EvidenceRecord):
    """An immutable proposal; it never owns or merges the referenced definitions."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    target_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    association_kind = models.CharField(max_length=20)
    observed_source_identifier = models.CharField(max_length=200)
    observed_target_identifier = models.CharField(max_length=200)
    basis = models.TextField()
    proposed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(EvidenceRecord.Meta):
        constraints = [
            *EvidenceRecord.Meta.constraints,
            models.CheckConstraint(
                condition=models.Q(association_kind__in=["import", "supplier", "model"]),
                name="matching_candidate_kind",
            ),
            models.CheckConstraint(
                condition=~models.Q(basis="")
                & ~models.Q(observed_source_identifier="")
                & ~models.Q(observed_target_identifier=""),
                name="matching_candidate_nonempty",
            ),
        ]


class MatchReview(EvidenceRecord):
    """Append-only review; the latest sequential row determines current decision."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    candidate = models.ForeignKey(MatchCandidate, on_delete=models.PROTECT, related_name="reviews")
    version = models.PositiveIntegerField()
    decision = models.CharField(max_length=20)
    basis = models.TextField()
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(EvidenceRecord.Meta):
        constraints = [
            *EvidenceRecord.Meta.constraints,
            models.UniqueConstraint(
                fields=["candidate", "version"], name="matching_review_version"
            ),
            models.CheckConstraint(
                condition=models.Q(decision__in=["accepted", "rejected", "needs_evidence"])
                & ~models.Q(basis="")
                & models.Q(version__gte=1),
                name="matching_review_valid",
            ),
        ]
