import uuid

from django.conf import settings
from django.db import models


class PcbIntake(models.Model):
    """Metadata-only intake. No source bytes are interpreted by this process."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_revision = models.ForeignKey("sources.SourceBundleRevision", on_delete=models.PROTECT)
    board_path = models.CharField(max_length=512, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["source_revision", "board_path"], name="pcb_intake_source_board"
            )
        ]


class PcbExtractionAttempt(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    intake = models.ForeignKey(PcbIntake, on_delete=models.PROTECT, related_name="attempts")
    build = models.OneToOneField("builds.BuildAttempt", on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class PcbInterpretation(models.Model):
    """Accepted interpretation is immutable, distinct from its authoritative source."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    attempt = models.OneToOneField(PcbExtractionAttempt, on_delete=models.PROTECT)
    output = models.OneToOneField("builds.StageOutput", on_delete=models.PROTECT)
    canonical = models.BinaryField()
    sha256 = models.CharField(max_length=64)
    accepted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)


class PropertyAuthority(models.Model):
    """One designated native owner for a governed property of a board source lineage.

    Specmate keeps no editable copy of the property: edits go through the owning source
    and immutable projections reconcile extracted values with exact provenance.
    """

    class Property(models.TextChoices):
        BOARD_OUTLINE = "pcb.board_outline"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    property = models.CharField(max_length=100, choices=Property.choices)
    lineage_root = models.ForeignKey(
        "sources.SourceBundle", on_delete=models.PROTECT, related_name="+"
    )
    owner_bundle = models.ForeignKey(
        "sources.SourceBundle", on_delete=models.PROTECT, related_name="+"
    )
    owner_path = models.CharField(max_length=512)
    extractor = models.CharField(max_length=100)
    version = models.PositiveIntegerField(default=1)
    basis = models.TextField(max_length=2000)
    declared_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["lineage_root", "owner_path", "property"],
                name="pcb_property_authority_one_owner",
            )
        ]


class PropertyOwnerChange(models.Model):
    """Immutable record of a deliberate owner declaration or transfer."""

    authority = models.ForeignKey(
        PropertyAuthority, on_delete=models.PROTECT, related_name="owner_changes"
    )
    version = models.PositiveIntegerField()
    owner_revision = models.ForeignKey(
        "sources.SourceBundleRevision", on_delete=models.PROTECT, related_name="+"
    )
    owner_path = models.CharField(max_length=512)
    basis = models.TextField(max_length=2000)
    changed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["authority", "version"], name="pcb_property_owner_change_version"
            )
        ]


class PropertyProjection(models.Model):
    """Immutable reconciled projection of an owned property from one accepted extraction."""

    class Status(models.TextChoices):
        KNOWN = "known"
        UNKNOWN = "unknown"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    authority = models.ForeignKey(
        PropertyAuthority, on_delete=models.PROTECT, related_name="projections"
    )
    version = models.PositiveIntegerField()
    interpretation = models.ForeignKey(
        PcbInterpretation, on_delete=models.PROTECT, related_name="+"
    )
    source_revision = models.ForeignKey(
        "sources.SourceBundleRevision", on_delete=models.PROTECT, related_name="+"
    )
    source_path = models.CharField(max_length=512)
    source_sha256 = models.CharField(max_length=64)
    report_sha256 = models.CharField(max_length=64)
    status = models.CharField(max_length=20, choices=Status.choices)
    value = models.BinaryField()
    value_sha256 = models.CharField(max_length=64)
    previous = models.ForeignKey("self", null=True, on_delete=models.PROTECT, related_name="+")
    changes = models.JSONField()
    basis = models.TextField(max_length=2000)
    reconciled_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["authority", "version"], name="pcb_property_projection_version"
            )
        ]
