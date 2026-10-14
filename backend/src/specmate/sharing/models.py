import uuid

from django.conf import settings
from django.db import models


class ShareRecord(models.Model):
    """Append-only who/what/when row for one output leaving the workspace (KNW-004).

    Workspaces are private. An export package, selected package or release archive handed
    to a person or file is recorded here with the exact bytes' hashes. A record is not a
    link and grants nothing; nothing in the product is public by default.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=20)
    root_revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    release_id = models.UUIDField(null=True, blank=True)
    purpose = models.CharField(max_length=40)
    archive_sha256 = models.CharField(max_length=64)
    manifest_sha256 = models.CharField(max_length=64)
    shared_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    shared_at = models.DateTimeField(auto_now_add=True)
    via = models.CharField(max_length=20)

    class Meta:
        indexes = [models.Index(fields=["workspace", "-shared_at"], name="share_ws_time")]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(kind__in=["export_package", "selected_package", "release"])
                & models.Q(archive_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(manifest_sha256__regex=r"^[0-9a-f]{64}$"),
                name="share_valid",
            )
        ]
