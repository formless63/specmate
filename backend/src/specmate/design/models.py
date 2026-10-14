"""Definitions, editable drafts and immutable snapshots/revisions (docs/DOMAIN.md).

Snapshot, SnapshotDependency and Revision rows are protected against UPDATE and
DELETE by database triggers (see migrations), not only by application code.
"""

import uuid

from django.conf import settings
from django.core.validators import RegexValidator
from django.db import models

kind_validator = RegexValidator(r"^[a-z][a-z0-9_]{0,49}$", "Kind must be a lowercase slug.")


class Definition(models.Model):
    """A reusable engineering identity. Content lives in drafts and frozen revisions."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        "access.Workspace", on_delete=models.PROTECT, related_name="definitions"
    )
    kind = models.CharField(max_length=50, validators=[kind_validator])
    name = models.CharField(max_length=200)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class Draft(models.Model):
    """Editable, possibly incomplete state with an optimistic concurrency version."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    definition = models.ForeignKey(Definition, on_delete=models.PROTECT, related_name="drafts")
    content = models.JSONField(default=dict)
    version = models.PositiveIntegerField(default=1)
    base_revision = models.ForeignKey(
        "Revision", null=True, on_delete=models.PROTECT, related_name="+"
    )
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    updated_at = models.DateTimeField(auto_now=True)

    @property
    def state_token(self) -> str:
        return f"draft-v{self.version}"


class Snapshot(models.Model):
    """Exact immutable state: canonical bytes plus their hash and dependency pins."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    definition = models.ForeignKey(Definition, on_delete=models.PROTECT, related_name="snapshots")
    draft = models.ForeignKey(Draft, on_delete=models.PROTECT, related_name="snapshots")
    draft_version = models.PositiveIntegerField()
    canonical = models.BinaryField()
    sha256 = models.CharField(max_length=64)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class SnapshotDependency(models.Model):
    snapshot = models.ForeignKey(Snapshot, on_delete=models.PROTECT, related_name="dependencies")
    revision = models.ForeignKey("Revision", on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["snapshot", "revision"], name="snapshot_dependency")
        ]


class Revision(models.Model):
    """A frozen, numbered revision of a definition, backed by one snapshot."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    definition = models.ForeignKey(Definition, on_delete=models.PROTECT, related_name="revisions")
    number = models.PositiveIntegerField()
    snapshot = models.OneToOneField(Snapshot, on_delete=models.PROTECT, related_name="revision")
    frozen_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    frozen_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["definition", "number"], name="revision_number")
        ]
