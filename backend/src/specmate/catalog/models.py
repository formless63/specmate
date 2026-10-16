"""Append-only catalog associations; design identity and inventory remain separate."""

import uuid

from django.conf import settings
from django.db import models


class DefinitionLifecycle(models.Model):
    """Append-only catalog disposition; exact historical revisions remain readable."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    definition = models.ForeignKey(
        "design.Definition", on_delete=models.PROTECT, related_name="lifecycle_events"
    )
    sequence = models.PositiveIntegerField()
    status = models.CharField(max_length=20)
    replacement = models.ForeignKey(
        "design.Revision", null=True, on_delete=models.PROTECT, related_name="+"
    )
    basis = models.TextField()
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["definition", "sequence"], name="catalog_lifecycle_sequence"
            ),
            models.CheckConstraint(
                condition=models.Q(sequence__gte=1)
                & ~models.Q(basis="")
                & (
                    models.Q(status="superseded", replacement__isnull=False)
                    | models.Q(
                        status__in=["active", "development", "legacy", "retired"],
                        replacement__isnull=True,
                    )
                ),
                name="catalog_lifecycle_valid",
            ),
        ]


class ManufacturerVariant(models.Model):
    """An asserted orderable identity associated with one exact design revision.

    A shared part number never merges definitions or establishes interchangeability.
    Corrections create new records; physical lots can retain their original association.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="manufacturer_variants"
    )
    manufacturer = models.CharField(max_length=200)
    part_number = models.CharField(max_length=200)
    association_basis = models.TextField()
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["revision", "manufacturer", "part_number"], name="catalog_variant_identity"
            ),
            models.CheckConstraint(
                condition=~models.Q(manufacturer="")
                & ~models.Q(part_number="")
                & ~models.Q(association_basis=""),
                name="catalog_variant_nonempty",
            ),
        ]


class Representation(models.Model):
    """A source representation of an exact revision, never a physical item."""

    class Kind(models.TextChoices):
        SYMBOL = "symbol"
        FOOTPRINT = "footprint"
        MODEL = "model"
        DRAWING = "drawing"
        DATASHEET = "datasheet"

    class RightsStatus(models.TextChoices):
        CLEARED = "cleared"
        RESTRICTED = "restricted"
        UNKNOWN = "unknown"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="representations"
    )
    rights_status = models.CharField(max_length=20, choices=RightsStatus.choices)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    label = models.CharField(max_length=200)
    source_file = models.ForeignKey("sources.SourceBundleFile", on_delete=models.PROTECT)
    model_metadata = models.JSONField(null=True, default=None)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["revision", "kind", "source_file"], name="catalog_representation_identity"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    kind__in=["symbol", "footprint", "model", "drawing", "datasheet"]
                ),
                name="catalog_representation_kind",
            ),
            models.CheckConstraint(
                condition=~models.Q(label=""), name="catalog_representation_label"
            ),
            models.CheckConstraint(
                condition=models.Q(rights_status__in=["cleared", "restricted", "unknown"]),
                name="catalog_representation_rights_status",
            ),
            models.CheckConstraint(
                condition=models.Q(model_metadata__isnull=True) | models.Q(kind="model"),
                name="catalog_representation_model_only",
            ),
        ]


class SourceIdentifier(models.Model):
    """An external source reference (library id, URL, standard number) of an exact revision.

    It names where something is published; it holds no bytes, and nothing is fetched.
    Rights are always stated, though the statement may be an explicit "unknown".
    """

    class RightsStatus(models.TextChoices):
        CLEARED = "cleared"
        RESTRICTED = "restricted"
        UNKNOWN = "unknown"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="source_identifiers"
    )
    rights_status = models.CharField(max_length=20, choices=RightsStatus.choices)
    scheme = models.CharField(max_length=60)
    identifier = models.CharField(max_length=512)
    label = models.CharField(max_length=200)
    rights = models.CharField(max_length=200)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["revision", "scheme", "identifier"], name="catalog_source_identifier"
            ),
            models.CheckConstraint(
                condition=~models.Q(scheme="")
                & ~models.Q(identifier="")
                & ~models.Q(label="")
                & ~models.Q(rights=""),
                name="catalog_source_identifier_nonempty",
            ),
            models.CheckConstraint(
                condition=models.Q(rights_status__in=["cleared", "restricted", "unknown"]),
                name="catalog_source_identifier_rights_status",
            ),
        ]


class PhysicalLot(models.Model):
    """Physical batch identity. Quantities and stock transactions belong to inventory."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="lots")
    variant = models.ForeignKey(ManufacturerVariant, null=True, on_delete=models.PROTECT)
    label = models.CharField(max_length=200)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=~models.Q(label=""), name="catalog_lot_label"),
        ]
