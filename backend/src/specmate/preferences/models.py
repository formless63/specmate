import uuid

from django.conf import settings
from django.db import models


class MakerPreferences(models.Model):
    """Defaults for forms and agents. A preference is never an engineering fact.

    One row per workspace (``user`` null) and one optional override row per member. The
    stored keys are only those explicitly set; an absent key is "no preference", which
    stays unknown rather than becoming a built-in default.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    values = models.JSONField(default=dict)
    version = models.PositiveIntegerField(default=1)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "user"],
                condition=models.Q(user__isnull=False),
                name="preferences_user_unique",
            ),
            models.UniqueConstraint(
                fields=["workspace"],
                condition=models.Q(user__isnull=True),
                name="preferences_workspace_unique",
            ),
        ]
