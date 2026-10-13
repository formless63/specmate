import uuid

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models


class Installation(models.Model):
    """Singleton row identifying this installation and its owner."""

    singleton = models.BooleanField(primary_key=True, default=True)
    installation_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(singleton=True), name="installation_singleton"
            )
        ]


class OwnerSetupToken(models.Model):
    """One-use, short-lived token for claiming installation ownership. Only a hash is kept."""

    token_sha256 = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True)
    revoked_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class Project(models.Model):
    """A private scope for engineering records. Visibility comes only from membership."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class Membership(models.Model):
    class Role(models.TextChoices):
        OWNER = "owner"
        EDITOR = "editor"
        VIEWER = "viewer"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    role = models.CharField(max_length=20, choices=Role.choices)
    # Explicit grants beyond the role, e.g. design.freeze for an editor.
    grants = ArrayField(models.CharField(max_length=50), default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "user"], name="membership_project_user")
        ]
