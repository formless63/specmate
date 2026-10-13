"""Immutable receipts own generated output references; bytes use the shared blobstore."""

import uuid

from django.conf import settings
from django.db import models

from specmate.preparation_documents.contracts import DOCUMENTS


class DocumentSet(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    root_revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT)
    configuration = models.JSONField()
    manifest = models.JSONField()
    sha256 = models.CharField(max_length=64)
    generator = models.CharField(max_length=100)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(sha256__regex=r"^[0-9a-f]{64}$"),
                name="prep_document_input_digest",
            ),
        ]


class DocumentOutput(models.Model):
    document_set = models.ForeignKey(DocumentSet, on_delete=models.PROTECT, related_name="outputs")
    filename = models.CharField(max_length=100)
    media_type = models.CharField(max_length=100)
    sha256 = models.CharField(max_length=64)
    size = models.PositiveIntegerField()
    rights = models.CharField(max_length=200)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["document_set", "filename"], name="prep_document_filename"
            ),
            models.CheckConstraint(
                condition=models.Q(sha256__regex=r"^[0-9a-f]{64}$"),
                name="prep_document_output_digest",
            ),
            models.CheckConstraint(
                condition=models.Q(size__gt=0, size__lte=2097152), name="prep_document_output_size"
            ),
            models.CheckConstraint(
                condition=models.Q(filename__in=DOCUMENTS), name="prep_document_output_name"
            ),
        ]
