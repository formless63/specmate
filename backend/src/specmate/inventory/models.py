"""Physical identity is catalog-owned; this ledger owns dimensional stock assertions."""

import uuid

from django.conf import settings
from django.db import models


class Location(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey("access.Project", on_delete=models.PROTECT)
    name = models.CharField(max_length=200)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "name"], name="inventory_location_name"),
            models.CheckConstraint(
                condition=~models.Q(name=""), name="inventory_location_nonempty"
            ),
        ]


class StockAccount(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    lot = models.ForeignKey("catalog.PhysicalLot", on_delete=models.PROTECT)
    location = models.ForeignKey(Location, on_delete=models.PROTECT)
    dimension = models.CharField(max_length=10)
    state = models.UUIDField(default=uuid.uuid4)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["lot", "location"], name="inventory_lot_location"),
            models.CheckConstraint(
                condition=models.Q(dimension__in=["count", "length", "mass"]),
                name="inventory_dimension",
            ),
        ]


class StockEntry(models.Model):
    """An immutable assertion and transition; NULL balance means explicitly unknown."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account = models.ForeignKey(StockAccount, on_delete=models.PROTECT, related_name="entries")
    sequence = models.PositiveIntegerField()
    kind = models.CharField(max_length=12)
    amount = models.DecimalField(max_digits=24, decimal_places=9, null=True)
    unit = models.CharField(max_length=5)
    before = models.DecimalField(max_digits=24, decimal_places=9, null=True)
    after = models.DecimalField(max_digits=24, decimal_places=9, null=True)
    reservation = models.ForeignKey("Reservation", null=True, on_delete=models.PROTECT)
    work_batch = models.ForeignKey("WorkBatch", null=True, on_delete=models.PROTECT)
    consumption_origin = models.ForeignKey(
        "self", null=True, on_delete=models.PROTECT, related_name="returns"
    )
    reason = models.TextField()
    assertion_source = models.CharField(max_length=1000)
    assertion_status = models.CharField(max_length=12)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["account", "sequence"], name="inventory_entry_sequence"
            ),
            models.CheckConstraint(
                condition=models.Q(after__isnull=True) | models.Q(after__gte=0),
                name="inventory_nonnegative_balance",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    kind__in=[
                        "opening",
                        "receipt",
                        "adjustment",
                        "observation",
                        "consumption",
                        "return",
                    ]
                ),
                name="inventory_entry_kind",
            ),
            models.CheckConstraint(
                condition=models.Q(assertion_status__in=["declared", "observed", "measured"]),
                name="inventory_assertion_status",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        kind="consumption",
                        reservation__isnull=False,
                        work_batch__isnull=False,
                        consumption_origin__isnull=True,
                    )
                    | models.Q(
                        kind="return",
                        reservation__isnull=True,
                        work_batch__isnull=False,
                        consumption_origin__isnull=False,
                    )
                    | (
                        ~models.Q(kind__in=["consumption", "return"])
                        & models.Q(
                            reservation__isnull=True,
                            work_batch__isnull=True,
                            consumption_origin__isnull=True,
                        )
                    )
                ),
                name="inventory_entry_cause",
            ),
        ]


class Reservation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account = models.ForeignKey(StockAccount, on_delete=models.PROTECT, related_name="reservations")
    quantity = models.DecimalField(max_digits=24, decimal_places=9)
    amount = models.DecimalField(max_digits=24, decimal_places=9)
    unit = models.CharField(max_length=5)
    purpose = models.TextField()
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0), name="inventory_reserve_positive"
            ),
        ]


class ReservationRelease(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reservation = models.OneToOneField(
        Reservation, on_delete=models.PROTECT, related_name="release"
    )
    reason = models.TextField()
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)


class WorkBatch(models.Model):
    """Planned job/batch target. Reported progress is not serialized physical membership."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT)
    kind = models.CharField(max_length=8)
    label = models.CharField(max_length=200)
    planned_units = models.PositiveIntegerField(null=True)
    state = models.UUIDField(default=uuid.uuid4)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(kind__in=["job", "batch"]), name="inventory_work_kind"
            ),
            models.CheckConstraint(condition=~models.Q(label=""), name="inventory_work_label"),
            models.CheckConstraint(
                condition=models.Q(planned_units__isnull=True) | models.Q(planned_units__gt=0),
                name="inventory_work_plan_positive",
            ),
        ]


class WorkCompletion(models.Model):
    """Append a completion-count assertion, without inventing actual unit identities."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    work_batch = models.ForeignKey(WorkBatch, on_delete=models.PROTECT, related_name="completions")
    sequence = models.PositiveIntegerField()
    units_completed = models.PositiveIntegerField()
    reason = models.TextField()
    assertion_source = models.CharField(max_length=1000)
    assertion_status = models.CharField(max_length=12)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["work_batch", "sequence"], name="inventory_completion_sequence"
            ),
            models.CheckConstraint(
                condition=models.Q(units_completed__gt=0), name="inventory_completion_positive"
            ),
            models.CheckConstraint(
                condition=models.Q(assertion_status__in=["declared", "observed", "measured"]),
                name="inventory_completion_status",
            ),
        ]
