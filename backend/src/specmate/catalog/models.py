"""Append-only catalog associations; design identity and inventory remain separate."""

import uuid

from django.conf import settings
from django.db import models


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

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="representations"
    )
    kind = models.CharField(max_length=20, choices=Kind.choices)
    label = models.CharField(max_length=200)
    source_file = models.ForeignKey("sources.SourceBundleFile", on_delete=models.PROTECT)
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
