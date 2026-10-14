"""Reviewed, dated supplier offers: immutable workspace records, never live prices."""

import uuid

from django.conf import settings
from django.db import models


class SupplierOffer(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    # The exact item revision the supplier offers.
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    supplier = models.CharField(max_length=200)
    supplier_ref = models.CharField(max_length=200, blank=True)
    # Where the offer text came from (quote, catalog page, email) and the reviewer's basis.
    source = models.CharField(max_length=1000)
    review_basis = models.TextField()
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    offered_on = models.DateField()
    valid_until = models.DateField(null=True)
    # Price and currency are independently optional; absent stays unknown, never zero.
    price_amount = models.DecimalField(max_digits=24, decimal_places=9, null=True)
    price_currency = models.CharField(max_length=3, null=True)  # noqa: DJ001
    price_unit = models.CharField(max_length=5, default="ea")
    availability = models.CharField(max_length=12, default="unknown")
    lead_time_days = models.PositiveIntegerField(null=True)
    # A substitute offers a different revision for the need of ``substitute_for``.
    substitute_for = models.ForeignKey(
        "design.Revision", null=True, on_delete=models.PROTECT, related_name="+"
    )
    substitution_basis = models.TextField(blank=True)
    supersedes = models.OneToOneField(
        "self", null=True, on_delete=models.PROTECT, related_name="superseded_by"
    )
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    availability__in=["in_stock", "limited", "unavailable", "unknown"]
                ),
                name="sourcing_offer_availability",
            ),
            models.CheckConstraint(
                condition=models.Q(price_amount__isnull=True) | models.Q(price_amount__gte=0),
                name="sourcing_offer_price_nonnegative",
            ),
            models.CheckConstraint(
                condition=models.Q(valid_until__isnull=True)
                | models.Q(valid_until__gte=models.F("offered_on")),
                name="sourcing_offer_validity_order",
            ),
            models.CheckConstraint(
                condition=models.Q(substitute_for__isnull=True) | ~models.Q(substitution_basis=""),
                name="sourcing_offer_substitution_basis",
            ),
            models.CheckConstraint(
                condition=~models.Q(supplier="")
                & ~models.Q(source="")
                & ~models.Q(review_basis=""),
                name="sourcing_offer_nonblank",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "revision"]),
            models.Index(fields=["substitute_for"]),
        ]
