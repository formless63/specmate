import uuid

from django.conf import settings
from django.db import models


class Release(models.Model):
    """An immutable reviewed release closure: a workspace item, never owned by a project.

    ``record`` is the exact reviewed closure (revisions, configurations, dependencies,
    artifacts, rights, evidence applicability and unresolved items) with the release
    decision; ``record_canonical`` holds its exact bytes. The coherent package archive
    is retained by content address. Nothing here is rewritten: later warnings attach as
    separate records that reference the release.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=200)
    root_revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    request = models.JSONField()
    record = models.JSONField()
    record_canonical = models.BinaryField()
    record_sha256 = models.CharField(max_length=64)
    review_sha256 = models.CharField(max_length=64)
    manifest_sha256 = models.CharField(max_length=64)
    archive_sha256 = models.CharField(max_length=64)
    archive_bytes = models.PositiveBigIntegerField()
    unresolved_count = models.PositiveIntegerField()
    acknowledgement_reason = models.TextField(blank=True, default="")
    released_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    released_at = models.DateTimeField(auto_now_add=True)
    request_id = models.CharField(max_length=200)

    class Meta:
        indexes = [models.Index(fields=["workspace", "-released_at"], name="release_ws_time")]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(name__regex=r"\S")
                & models.Q(record_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(review_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(manifest_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(archive_sha256__regex=r"^[0-9a-f]{64}$"),
                name="release_valid",
            ),
            # Unresolved items are released only with an explicit, stated acknowledgement.
            models.CheckConstraint(
                condition=models.Q(unresolved_count=0)
                | models.Q(acknowledgement_reason__regex=r"\S"),
                name="release_unresolved_acknowledged",
            ),
        ]


class ReleasePin(models.Model):
    """One exact frozen revision of the release closure (database-visible where-used)."""

    release = models.ForeignKey(Release, on_delete=models.PROTECT, related_name="pins")
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    role = models.CharField(max_length=20)
    sha256 = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["release", "revision"], name="release_pin_unique"),
            models.CheckConstraint(
                condition=models.Q(role__in=["root", "occurrence", "dependency"]),
                name="release_pin_role",
            ),
        ]


class ReleaseConfiguration(models.Model):
    """One exact resolved configuration the closure is released as."""

    release = models.ForeignKey(Release, on_delete=models.PROTECT, related_name="configurations")
    configuration = models.ForeignKey(
        "configurations.ResolvedConfiguration", on_delete=models.PROTECT, related_name="+"
    )
    resolution_sha256 = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["release", "configuration"], name="release_configuration_unique"
            )
        ]
