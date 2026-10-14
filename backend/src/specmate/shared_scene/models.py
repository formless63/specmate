import uuid

from django.conf import settings
from django.db import models


class SceneDrawing(models.Model):
    """Immutable derived inspection bytes, not design state or release evidence."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    snapshot = models.ForeignKey("design.Snapshot", on_delete=models.PROTECT)
    renderer_version = models.CharField(max_length=50)
    purpose = models.CharField(max_length=50)
    options = models.JSONField()
    svg = models.BinaryField()
    manifest = models.BinaryField()
    svg_sha256 = models.CharField(max_length=64)
    manifest_sha256 = models.CharField(max_length=64)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(purpose="internal_inspection"), name="scene_drawing_internal"
            ),
            models.CheckConstraint(
                condition=models.Q(svg_sha256__regex=r"^[0-9a-f]{64}$"), name="scene_svg_hash"
            ),
            models.CheckConstraint(
                condition=models.Q(manifest_sha256__regex=r"^[0-9a-f]{64}$"),
                name="scene_manifest_hash",
            ),
        ]
