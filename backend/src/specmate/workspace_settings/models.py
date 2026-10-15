from django.conf import settings
from django.db import models


class WorkspaceSettings(models.Model):
    workspace = models.OneToOneField("access.Workspace", on_delete=models.PROTECT, primary_key=True)
    values = models.JSONField(default=dict)
    version = models.PositiveIntegerField(default=1)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    updated_at = models.DateTimeField(auto_now=True)
