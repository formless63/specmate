from django.conf import settings
from django.db import models


class IdempotencyRecord(models.Model):
    """Stored outcome of a keyed request, scoped to actor, workspace namespace and operation."""

    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    operation = models.CharField(max_length=100)
    scope = models.CharField(max_length=64)
    key = models.CharField(max_length=128)
    fingerprint = models.CharField(max_length=64)
    result = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["actor", "scope", "operation", "key"],
                name="idempotency_actor_scope_operation_key",
            ),
            models.CheckConstraint(
                condition=models.Q(scope="global")
                | models.Q(
                    scope__regex=r"^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
                ),
                name="idempotency_valid_scope",
            ),
        ]
