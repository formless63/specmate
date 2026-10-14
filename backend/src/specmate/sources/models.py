"""Workspace-held source bytes and versioned original/derivative bundles.

SourceBlob, SourceBundleRevision and SourceBundleFile are immutable (database triggers).
"""

import uuid

from django.conf import settings
from django.db import models


class SourceBlob(models.Model):
    """Registration of exact bytes in one workspace. Identical bytes in another workspace
    are a separate registration; existence is never revealed across workspaces."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        "access.Workspace", on_delete=models.PROTECT, related_name="source_blobs"
    )
    sha256 = models.CharField(max_length=64)
    size = models.PositiveBigIntegerField()
    media_type = models.CharField(max_length=200)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "sha256"], name="source_blob_workspace_hash"
            )
        ]


class SourceBundle(models.Model):
    class Role(models.TextChoices):
        ORIGINAL = "original"
        DERIVATIVE = "derivative"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        "access.Workspace", on_delete=models.PROTECT, related_name="source_bundles"
    )
    name = models.CharField(max_length=200)
    role = models.CharField(max_length=20, choices=Role.choices)
    derived_from = models.ForeignKey(
        "SourceBundleRevision", null=True, on_delete=models.PROTECT, related_name="derivatives"
    )
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(role="original", derived_from__isnull=True)
                | models.Q(role="derivative", derived_from__isnull=False),
                name="source_bundle_role_ancestry",
            )
        ]


class SourceBundleRevision(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bundle = models.ForeignKey(SourceBundle, on_delete=models.PROTECT, related_name="revisions")
    number = models.PositiveIntegerField()
    manifest = models.BinaryField()
    manifest_sha256 = models.CharField(max_length=64)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["bundle", "number"], name="source_bundle_revision")
        ]


class SourceBundleFile(models.Model):
    revision = models.ForeignKey(
        SourceBundleRevision, on_delete=models.PROTECT, related_name="files"
    )
    path = models.CharField(max_length=512)
    blob = models.ForeignKey(SourceBlob, on_delete=models.PROTECT, related_name="+")
    media_type = models.CharField(max_length=200)
    rights = models.CharField(max_length=200)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["revision", "path"], name="source_bundle_file_path")
        ]


class SourceArchiveExpansion(models.Model):
    """Exact immutable parser provenance for the revision produced by ZIP expansion."""

    revision = models.OneToOneField(
        SourceBundleRevision,
        primary_key=True,
        on_delete=models.PROTECT,
        related_name="archive_expansion",
    )
    archive_file = models.ForeignKey(SourceBundleFile, on_delete=models.PROTECT, related_name="+")
    parser = models.CharField(max_length=100)


class SourceEditSubmission(models.Model):
    """Immutable review provenance for a revision re-entered from an editing handoff."""

    revision = models.OneToOneField(
        SourceBundleRevision,
        primary_key=True,
        on_delete=models.PROTECT,
        related_name="edit_submission",
    )
    baseline = models.ForeignKey(SourceBundleRevision, on_delete=models.PROTECT, related_name="+")
    archive_file = models.ForeignKey(
        SourceBundleFile, null=True, on_delete=models.PROTECT, related_name="+"
    )
    parser = models.CharField(max_length=100, blank=True)
    marker = models.CharField(max_length=20)
    root_prefix = models.CharField(max_length=512, blank=True)
    review_sha256 = models.CharField(max_length=64)
    summary = models.TextField(max_length=2000)
