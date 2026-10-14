"""Installation, workspace membership, projects and project references (docs/DOMAIN.md).

The workspace is the privacy boundary: every member reads everything in it and a
member's role decides what they may change. A project is a composition and decision
context that holds only its own records and references to workspace collection items.
"""

import uuid

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models

# Explicit authorities a member may hold beyond the role (docs/SECURITY.md).
GRANTABLE_PERMISSIONS = ("build.execute", "inventory.manage", "design.freeze")


class Workspace(models.Model):
    """Sharing and privacy boundary owning every global collection."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~models.Q(name=""), name="workspace_name")]


class Installation(models.Model):
    """Singleton row identifying this installation, its owner and its single workspace."""

    singleton = models.BooleanField(primary_key=True, default=True)
    installation_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    workspace = models.OneToOneField(
        Workspace, null=True, on_delete=models.PROTECT, related_name="+"
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


class WorkspaceMember(models.Model):
    class Role(models.TextChoices):
        VIEWER = "viewer"
        CONTRIBUTOR = "contributor"
        EDITOR = "editor"
        ADMIN = "admin"

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="workspace_memberships"
    )
    role = models.CharField(max_length=20, choices=Role.choices)
    # Explicit authorities beyond the role: native execution, inventory management and
    # freezing for a contributor.
    grants = ArrayField(models.CharField(max_length=50), default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "user"], name="workspace_member_user"),
            models.CheckConstraint(
                condition=models.Q(role__in=["viewer", "contributor", "editor", "admin"]),
                name="workspace_member_role",
            ),
            models.CheckConstraint(
                condition=models.Q(grants__contained_by=list(GRANTABLE_PERMISSIONS)),
                name="workspace_member_grants",
            ),
        ]


class Project(models.Model):
    """A composition and decision context. It owns no collection item; it references them."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.PROTECT, related_name="projects")
    name = models.CharField(max_length=200)
    purpose = models.CharField(max_length=2000, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    archived_at = models.DateTimeField(null=True)
    archived_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        indexes = [models.Index(fields=["workspace", "created_at"], name="project_workspace")]
        constraints = [
            models.CheckConstraint(condition=~models.Q(name=""), name="project_name"),
            models.CheckConstraint(
                condition=models.Q(archived_at__isnull=True, archived_by__isnull=True)
                | models.Q(archived_at__isnull=False, archived_by__isnull=False),
                name="project_archive_actor",
            ),
        ]


REFERENCE_TARGETS = ("definition", "revision", "source_bundle", "physical_unit", "work_batch")


def _only(target: str) -> models.Q:
    return models.Q(
        kind=target,
        **{f"{name}__isnull": name != target for name in REFERENCE_TARGETS},
    )


class ProjectReference(models.Model):
    """A project's declared use of one workspace item: floating (definition) or exact pin.

    Adding or removing a reference never creates, copies, moves or edits the item.
    Removal is recorded, not erased (database guards keep the row append-only).
    """

    class Kind(models.TextChoices):
        DEFINITION = "definition"
        REVISION = "revision"
        SOURCE_BUNDLE = "source_bundle"
        PHYSICAL_UNIT = "physical_unit"
        WORK_BATCH = "work_batch"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="references")
    kind = models.CharField(max_length=20, choices=Kind.choices)
    definition = models.ForeignKey(
        "design.Definition", null=True, on_delete=models.PROTECT, related_name="+"
    )
    revision = models.ForeignKey(
        "design.Revision", null=True, on_delete=models.PROTECT, related_name="+"
    )
    source_bundle = models.ForeignKey(
        "sources.SourceBundle", null=True, on_delete=models.PROTECT, related_name="+"
    )
    physical_unit = models.ForeignKey(
        "physical_units.PhysicalUnit", null=True, on_delete=models.PROTECT, related_name="+"
    )
    work_batch = models.ForeignKey(
        "inventory.WorkBatch", null=True, on_delete=models.PROTECT, related_name="+"
    )
    role = models.CharField(max_length=100)
    note = models.CharField(max_length=2000, blank=True)
    added_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    added_at = models.DateTimeField(auto_now_add=True)
    removed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    removed_at = models.DateTimeField(null=True)
    removal_request_id = models.CharField(max_length=200, blank=True)
    removal_reason = models.CharField(max_length=1000, blank=True)

    class Meta:
        indexes = [models.Index(fields=["project", "added_at"], name="project_reference_order")]
        constraints = [
            models.CheckConstraint(
                condition=_only("definition")
                | _only("revision")
                | _only("source_bundle")
                | _only("physical_unit")
                | _only("work_batch"),
                name="project_reference_target",
            ),
            models.CheckConstraint(condition=~models.Q(role=""), name="project_reference_role"),
            models.CheckConstraint(
                condition=models.Q(removed_at__isnull=True, removed_by__isnull=True)
                | models.Q(removed_at__isnull=False, removed_by__isnull=False),
                name="project_reference_removal",
            ),
            *(
                models.UniqueConstraint(
                    fields=["project", target, "role"],
                    condition=models.Q(kind=target, removed_at__isnull=True),
                    name=f"project_reference_active_{target}",
                )
                for target in REFERENCE_TARGETS
            ),
        ]

    @property
    def target_id(self):
        return getattr(self, f"{self.kind}_id")
