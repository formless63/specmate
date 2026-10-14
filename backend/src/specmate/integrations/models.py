"""Optional business integrations: declared field ownership, dated observations, export records.

Nothing here is an engineering fact or a stock ledger. Imported values are observations
attributed to an integration, a file hash and the importing actor; they never write
``StockEntry``, ``SupplierOffer`` or any design state.
"""

import uuid

from django.conf import settings
from django.db import models


class Integration(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=200)
    # Reference adapters are file based (csv/json). No connection details are stored.
    adapter = models.CharField(max_length=20, default="file")
    # {field: "external" | "specmate"}: which side owns each synchronized field.
    ownership = models.JSONField()
    # Optional {canonical column: external column} renames for the file adapter.
    columns = models.JSONField(default=dict)
    enabled = models.BooleanField(default=True)
    state = models.UUIDField(default=uuid.uuid4)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "name"], name="integrations_name"),
            models.CheckConstraint(condition=~models.Q(name=""), name="integrations_name_nonempty"),
        ]


class ImportRun(models.Model):
    """One explicit import of one file; identical content is recorded once per field."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    integration = models.ForeignKey(Integration, on_delete=models.PROTECT, related_name="runs")
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    field = models.CharField(max_length=20)
    file_name = models.CharField(max_length=300)
    file_format = models.CharField(max_length=4)
    content_sha256 = models.CharField(max_length=64)
    row_count = models.PositiveIntegerField()
    accepted_count = models.PositiveIntegerField()
    rejections = models.JSONField(default=list)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["integration", "field", "content_sha256"], name="integrations_run_content"
            ),
        ]


class ExternalObservation(models.Model):
    """A dated claim by an external system about an exact item revision."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(ImportRun, on_delete=models.PROTECT, related_name="observations")
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=20)
    row_number = models.PositiveIntegerField()
    external_ref = models.CharField(max_length=200, blank=True)
    # offered_on for supplier offers, observed_on for stock observations.
    observed_on = models.DateField()
    valid_until = models.DateField(null=True)
    # supplier_offer: unknown values stay NULL, never zero.
    supplier = models.CharField(max_length=200, blank=True)
    price_amount = models.DecimalField(max_digits=24, decimal_places=9, null=True)
    price_currency = models.CharField(max_length=3, null=True)  # noqa: DJ001
    price_unit = models.CharField(max_length=5, null=True)  # noqa: DJ001
    availability = models.CharField(max_length=12, null=True)  # noqa: DJ001
    lead_time_days = models.PositiveIntegerField(null=True)
    # stock_observation
    quantity_amount = models.DecimalField(max_digits=24, decimal_places=9, null=True)
    quantity_unit = models.CharField(max_length=5, null=True)  # noqa: DJ001
    location_label = models.CharField(max_length=200, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(kind__in=["supplier_offer", "stock_observation"]),
                name="integrations_observation_kind",
            ),
            models.CheckConstraint(
                condition=models.Q(price_amount__isnull=True) | models.Q(price_amount__gte=0),
                name="integrations_observation_price",
            ),
            models.CheckConstraint(
                condition=models.Q(quantity_amount__isnull=True) | models.Q(quantity_amount__gte=0),
                name="integrations_observation_quantity",
            ),
        ]
        indexes = [models.Index(fields=["workspace", "revision", "kind"])]


class ExportRecord(models.Model):
    """An explicit export of a frozen need; the exact bytes sent are retained."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    integration = models.ForeignKey(Integration, on_delete=models.PROTECT, related_name="exports")
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    plan_revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    purpose = models.CharField(max_length=20)
    file_format = models.CharField(max_length=4)
    content = models.TextField()
    content_sha256 = models.CharField(max_length=64)
    row_count = models.PositiveIntegerField()
    unresolved_count = models.PositiveIntegerField()
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)


class ObservationPromotion(models.Model):
    """Link from an external observation to the reviewed offer created from it."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    observation = models.OneToOneField(
        ExternalObservation, on_delete=models.PROTECT, related_name="promotion"
    )
    offer = models.OneToOneField(
        "sourcing.SupplierOffer", on_delete=models.PROTECT, related_name="+"
    )
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
