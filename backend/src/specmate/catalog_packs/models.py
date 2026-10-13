import uuid

from django.conf import settings
from django.db import models


class CatalogPack(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey("access.Project", on_delete=models.PROTECT)
    package_key = models.CharField(max_length=100)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "package_key"], name="pack_project_key"),
            models.CheckConstraint(condition=~models.Q(package_key=""), name="pack_key_nonempty"),
        ]


class PackVersion(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    pack = models.ForeignKey(CatalogPack, on_delete=models.PROTECT, related_name="versions")
    version = models.CharField(max_length=100)
    canonical = models.BinaryField()
    sha256 = models.CharField(max_length=64)
    manifest_source = models.ForeignKey(
        "sources.SourceBundleFile", null=True, on_delete=models.PROTECT
    )
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["pack", "version"], name="pack_exact_version"),
            models.CheckConstraint(condition=~models.Q(version=""), name="pack_version_nonempty"),
        ]


class VersionDependency(models.Model):
    version = models.ForeignKey(PackVersion, on_delete=models.PROTECT, related_name="dependencies")
    dependency = models.ForeignKey(PackVersion, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["version", "dependency"], name="pack_version_dependency"
            ),
            models.CheckConstraint(
                condition=~models.Q(version=models.F("dependency")), name="pack_no_self_dependency"
            ),
        ]


class VersionEntry(models.Model):
    version = models.ForeignKey(PackVersion, on_delete=models.PROTECT, related_name="entries")
    key = models.CharField(max_length=80)
    revision = models.ForeignKey("design.Revision", null=True, on_delete=models.PROTECT)
    source_file = models.ForeignKey("sources.SourceBundleFile", null=True, on_delete=models.PROTECT)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["version", "key"], name="pack_version_entry_key"),
        ]


class PackDecision(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    pack = models.ForeignKey(CatalogPack, on_delete=models.PROTECT, related_name="decisions")
    version = models.ForeignKey(PackVersion, on_delete=models.PROTECT)
    sequence = models.PositiveIntegerField()
    action = models.CharField(max_length=20)
    basis = models.TextField()
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["pack", "sequence"], name="pack_decision_sequence"),
            models.CheckConstraint(
                condition=models.Q(action__in=["install", "adopt", "disable"])
                & models.Q(sequence__gte=1)
                & ~models.Q(basis=""),
                name="pack_decision_valid",
            ),
        ]


class AdoptionEntry(models.Model):
    decision = models.ForeignKey(PackDecision, on_delete=models.PROTECT, related_name="adoptions")
    entry = models.ForeignKey(VersionEntry, on_delete=models.PROTECT)
    # Only controlled shared definition creation produces these owning-project drafts.
    definition = models.ForeignKey("design.Definition", null=True, on_delete=models.PROTECT)
    draft = models.ForeignKey("design.Draft", null=True, on_delete=models.PROTECT)
    initial_content = models.BinaryField(null=True)
    status = models.CharField(max_length=30)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["decision", "entry"], name="pack_adoption_entry"),
            models.CheckConstraint(
                condition=models.Q(
                    status="draft_created",
                    definition__isnull=False,
                    draft__isnull=False,
                    initial_content__isnull=False,
                )
                | models.Q(
                    status="inert_reference",
                    definition__isnull=True,
                    draft__isnull=True,
                    initial_content__isnull=True,
                ),
                name="pack_adoption_materialization",
            ),
        ]
