"""Proposal drafts are reviewable declarations; retained revisions are immutable derived records.

Neither touches canonical geometry, design drafts, frozen revisions or physical state.
"""

import uuid

from django.conf import settings
from django.db import models


class ProposalDraft(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    interpretation = models.ForeignKey(
        "pcb.PcbInterpretation", on_delete=models.PROTECT, related_name="+"
    )
    name = models.CharField(max_length=200)
    parameters = models.JSONField()
    version = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(version__gte=1), name="proposal_version"),
        ]
        indexes = [models.Index(fields=["workspace", "created_at"])]


class ProposalRevision(models.Model):
    """Exact generated proposal bytes pinned to one board interpretation and one draft version."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    draft = models.ForeignKey(ProposalDraft, on_delete=models.PROTECT, related_name="revisions")
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    number = models.PositiveIntegerField()
    interpretation = models.ForeignKey(
        "pcb.PcbInterpretation", on_delete=models.PROTECT, related_name="+"
    )
    interpretation_sha256 = models.CharField(max_length=64)
    generator = models.CharField(max_length=100)
    draft_version = models.PositiveIntegerField()
    status = models.CharField(max_length=40)
    canonical = models.BinaryField()
    sha256 = models.CharField(max_length=64)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["draft", "number"], name="proposal_revision_number"),
            models.UniqueConstraint(fields=["draft", "sha256"], name="proposal_revision_content"),
            models.CheckConstraint(
                condition=models.Q(sha256__regex=r"^[0-9a-f]{64}$"),
                name="proposal_revision_hash",
            ),
            models.CheckConstraint(
                condition=models.Q(interpretation_sha256__regex=r"^[0-9a-f]{64}$"),
                name="proposal_revision_interpretation_hash",
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["incomplete", "declared_inputs_complete"]),
                name="proposal_revision_status",
            ),
        ]
