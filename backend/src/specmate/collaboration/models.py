import uuid

from django.conf import settings
from django.db import models


class ChangeReview(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey("access.Project", on_delete=models.PROTECT)
    old_revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    candidate_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    knowledge_entry = models.ForeignKey(
        "knowledge.KnowledgeEntry", on_delete=models.PROTECT, null=True
    )
    title = models.CharField(max_length=200)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    version = models.PositiveIntegerField(default=1)

    @property
    def state_token(self):
        return f"team-review-v{self.version}"


class ReviewRecipient(models.Model):
    review = models.ForeignKey(ChangeReview, on_delete=models.PROTECT, related_name="recipients")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["review", "user"], name="collab_recipient_unique")
        ]


class ReviewEntry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    review = models.ForeignKey(ChangeReview, on_delete=models.PROTECT, related_name="entries")
    number = models.PositiveIntegerField()
    action = models.CharField(max_length=30)
    basis = models.TextField()
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    source_file = models.ForeignKey("sources.SourceBundleFile", on_delete=models.PROTECT, null=True)
    evidence_status = models.CharField(max_length=30, default="unknown")
    citation = models.TextField(null=True)  # noqa: DJ001 — absent citation is unknown
    upgrade_proposal = models.ForeignKey(
        "revision_upgrades.UpgradeProposal", on_delete=models.PROTECT, null=True
    )
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["review", "number"], name="collab_entry_number"),
            models.CheckConstraint(
                condition=models.Q(
                    action__in=[
                        "opened",
                        "comment",
                        "recommend",
                        "request_changes",
                        "decline",
                        "close",
                        "reopen",
                        "upgrade_proposed",
                    ]
                )
                & models.Q(number__gte=1)
                & ~models.Q(basis=""),
                name="collab_entry_valid",
            ),
        ]


class InternalNotification(models.Model):
    """Pointers only: protected labels and bodies are never copied into an inbox."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    entry = models.ForeignKey(ReviewEntry, on_delete=models.PROTECT, related_name="notifications")
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    read_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["entry", "recipient"], name="collab_notification_unique"
            )
        ]

    @property
    def state_token(self):
        return "notification-read" if self.read_at else "notification-unread"
