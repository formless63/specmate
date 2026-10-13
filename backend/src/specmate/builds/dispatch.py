"""Outbox transport metadata. Engineering transitions still use execute()."""

from dataclasses import dataclass
from uuid import UUID

from django.db.models import F
from django.utils import timezone

from specmate.builds.models import BuildOutbox


@dataclass(frozen=True)
class OutboxDelivery:
    id: UUID
    build_id: UUID
    workflow_id: str
    actor_id: int


def ready_outbox(limit: int = 20) -> list[OutboxDelivery]:
    return [
        OutboxDelivery(row.id, row.build_id, row.build.workflow_id, row.build.requested_by_id)
        for row in BuildOutbox.objects.filter(delivered_at__isnull=True)
        .select_related("build")
        .order_by("created_at")[:limit]
    ]


def ack_outbox(outbox_id: UUID) -> None:
    BuildOutbox.objects.filter(id=outbox_id, delivered_at__isnull=True).update(
        delivered_at=timezone.now(), delivery_attempts=F("delivery_attempts") + 1, last_error=""
    )


def record_dispatch_failure(outbox_id: UUID, error_code: str) -> None:
    # Callers supply a bounded safe code, never transport exception text or credentials.
    BuildOutbox.objects.filter(id=outbox_id, delivered_at__isnull=True).update(
        delivery_attempts=F("delivery_attempts") + 1, last_error=error_code[:200]
    )
