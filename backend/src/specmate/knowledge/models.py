"""One knowledge identity, append-only content entries and removable exact links.

Items belong to the workspace. An item with a project context is held by that project
(its notes and decisions); one without is a library note about the items it links.
An attachment references one registered source file of the same workspace. Entries and
attachment references are immutable. Links are never deleted: removal records who
removed them, so history stays retrievable.
"""

import uuid

from django.conf import settings
from django.db import models

KINDS = ("note", "decision", "attachment")
DECISION_STATUSES = ("proposed", "accepted", "rejected", "superseded")


class KnowledgeItem(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    # Project-held when set (project notes/decisions); a library note when null.
    project = models.ForeignKey(
        "access.Project", null=True, on_delete=models.PROTECT, related_name="+"
    )
    kind = models.CharField(max_length=12)
    version = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=models.Q(kind__in=KINDS), name="knowledge_item_kind")
        ]

    @property
    def state_token(self):
        return f"knowledge-v{self.version}"


class KnowledgeEntry(models.Model):
    """Immutable content of one item version; a revision appends the next entry."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    item = models.ForeignKey(KnowledgeItem, on_delete=models.PROTECT, related_name="entries")
    number = models.PositiveIntegerField()
    title = models.CharField(max_length=200)
    body = models.TextField(max_length=20000, blank=True)
    # NULL for notes and attachments; decisions always state their status.
    decision_status = models.CharField(max_length=12, null=True)  # noqa: DJ001
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["item", "number"], name="knowledge_entry_number"),
            models.CheckConstraint(
                condition=models.Q(decision_status__isnull=True)
                | models.Q(decision_status__in=DECISION_STATUSES),
                name="knowledge_entry_decision_status",
            ),
            models.CheckConstraint(condition=~models.Q(title=""), name="knowledge_entry_title"),
        ]


class KnowledgeAttachment(models.Model):
    """Reference to exact registered bytes; never a second blob registration."""

    entry = models.ForeignKey(KnowledgeEntry, on_delete=models.PROTECT, related_name="attachments")
    source_file = models.ForeignKey("sources.SourceBundleFile", on_delete=models.PROTECT)
    label = models.CharField(max_length=200, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["entry", "source_file"], name="knowledge_attachment_file"
            )
        ]


class KnowledgeLink(models.Model):
    """Exact target address in the item's workspace: a project or a collection item."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    item = models.ForeignKey(KnowledgeItem, on_delete=models.PROTECT, related_name="links")
    target_project = models.ForeignKey(
        "access.Project", null=True, on_delete=models.PROTECT, related_name="+"
    )
    kind = models.CharField(max_length=16)
    definition = models.ForeignKey("design.Definition", null=True, on_delete=models.PROTECT)
    revision = models.ForeignKey("design.Revision", null=True, on_delete=models.PROTECT)
    snapshot = models.ForeignKey("design.Snapshot", null=True, on_delete=models.PROTECT)
    physical_unit = models.ForeignKey(
        "physical_units.PhysicalUnit", null=True, on_delete=models.PROTECT
    )
    path = models.JSONField(default=list)
    feature_id = models.CharField(max_length=200, null=True)  # noqa: DJ001
    fingerprint = models.CharField(max_length=64)
    linked_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)
    removed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    removed_at = models.DateTimeField(null=True)
    removal_request_id = models.CharField(max_length=200, blank=True)
    removal_reason = models.CharField(max_length=1000, blank=True)

    class Meta:
        indexes = [models.Index(fields=["fingerprint"], name="knowledge_link_fingerprint")]
        constraints = [
            models.UniqueConstraint(
                fields=["item", "fingerprint"],
                condition=models.Q(removed_at__isnull=True),
                name="knowledge_link_active_target",
            ),
            models.CheckConstraint(
                condition=models.Q(removed_at__isnull=True, removed_by__isnull=True)
                | models.Q(removed_at__isnull=False, removed_by__isnull=False),
                name="knowledge_link_removal",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        kind="project",
                        definition__isnull=True,
                        revision__isnull=True,
                        snapshot__isnull=True,
                        physical_unit__isnull=True,
                        path=[],
                        feature_id__isnull=True,
                    )
                    | models.Q(
                        kind="definition",
                        definition__isnull=False,
                        revision__isnull=True,
                        snapshot__isnull=True,
                        physical_unit__isnull=True,
                        path=[],
                    )
                    | models.Q(
                        kind="revision",
                        definition__isnull=True,
                        revision__isnull=False,
                        snapshot__isnull=True,
                        physical_unit__isnull=True,
                        path=[],
                    )
                    | (
                        models.Q(
                            kind="occurrence",
                            definition__isnull=True,
                            revision__isnull=True,
                            snapshot__isnull=False,
                            physical_unit__isnull=True,
                        )
                        & ~models.Q(path=[])
                    )
                    | models.Q(
                        kind="physical_unit",
                        definition__isnull=True,
                        revision__isnull=True,
                        snapshot__isnull=True,
                        physical_unit__isnull=False,
                        path=[],
                        feature_id__isnull=True,
                    )
                ),
                name="knowledge_link_target",
            ),
            models.CheckConstraint(
                condition=models.Q(kind="project", target_project__isnull=False)
                | (~models.Q(kind="project") & models.Q(target_project__isnull=True)),
                name="knowledge_link_project",
            ),
        ]
