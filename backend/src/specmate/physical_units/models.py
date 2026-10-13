"""Immutable actual subjects, distinct from design, stock quantity, and planned work."""

import uuid

from django.conf import settings
from django.db import models


class PhysicalUnit(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey("access.Project", on_delete=models.PROTECT)
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT)
    lot = models.ForeignKey("catalog.PhysicalLot", null=True, on_delete=models.PROTECT)
    variant = models.ForeignKey("catalog.ManufacturerVariant", null=True, on_delete=models.PROTECT)
    serial = models.CharField(max_length=200)
    origin = models.CharField(max_length=12)
    assertion_source = models.CharField(max_length=1000)
    assertion_status = models.CharField(max_length=12)
    registered_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project", "serial"], name="physical_unit_project_serial"
            ),
            models.CheckConstraint(
                condition=~models.Q(serial=""), name="physical_unit_serial_nonempty"
            ),
            models.CheckConstraint(
                condition=models.Q(origin__in=["obtained", "assembled"]),
                name="physical_unit_origin",
            ),
            models.CheckConstraint(
                condition=models.Q(assertion_status__in=["declared", "observed", "measured"]),
                name="physical_unit_assertion_status",
            ),
            models.CheckConstraint(
                condition=~models.Q(assertion_source=""),
                name="physical_unit_assertion_source",
            ),
        ]


class WorkUnitLink(models.Model):
    """A factual subject/work association, without asserting completion or qualification."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    unit = models.OneToOneField(PhysicalUnit, on_delete=models.PROTECT, related_name="work_link")
    work_batch = models.ForeignKey("inventory.WorkBatch", on_delete=models.PROTECT)
    assertion_source = models.CharField(max_length=1000)
    assertion_status = models.CharField(max_length=12)
    linked_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(assertion_source=""),
                name="physical_work_link_source",
            ),
            models.CheckConstraint(
                condition=models.Q(assertion_status__in=["declared", "observed", "measured"]),
                name="physical_work_link_status",
            ),
        ]
