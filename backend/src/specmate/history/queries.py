"""Bounded history projections. Receipts are evidence of keyed calls, not old content."""

from uuid import UUID

from django.core import signing
from django.db.models import F
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from specmate.access.permissions import Perm, authorize
from specmate.design.closure_reads import closure_reads
from specmate.design.models import Draft, Revision
from specmate.design.operations import authorize_design_content, authorize_snapshots
from specmate.operations import OperationError, ValidationFailed
from specmate.operations.models import IdempotencyRecord

SCAN_LIMIT = 100
SALT = "workspace-history-v1"
# Only these result shapes have reviewed top-level engineering identities. No raw JSON
# result, payload, idempotency key, fingerprint, email or source content is projected.
RECEIPTS = {"definition.create", "draft.update", "draft.freeze"} | {
    f"{family}.{action}"
    for family in (
        "wire_stock",
        "interface",
        "cable",
        "harness",
        "assembly",
        "workshop_profile",
        "preparation",
        "end_preparation",
        "print_profile",
        "print_preparation",
        "cable_test_plan",
    )
    for action in ("create", "update", "freeze")
}
HINT = (
    "Keyed engineering receipts and immutable frozen revisions are separate evidence. "
    "This is not a complete edit audit. An update receipt does not retain old draft content; "
    "its draft link opens current state. A freeze can have both a receipt and revision row."
)
DRAFT_HINT = (
    "Current draft observations show only each draft's latest updater, time and token. "
    "They are not historical content. Drafts can move or disappear while paging; refresh "
    "to start a new current observation."
)


def _uuid(value):
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _position(user, query):
    filters = query.model_dump(mode="json", exclude={"after", "limit"})
    if query.after is None:
        return timezone.now(), {}, filters
    try:
        value = signing.loads(query.after, salt=SALT, max_age=86400)
        anchor = parse_datetime(value["anchor"])
        offsets = value["offsets"]
        if (
            value["actor"] != str(user.pk)
            or value["filters"] != filters
            or anchor is None
            or anchor.tzinfo is None
            or not isinstance(offsets, dict)
            or any(key not in {"receipt", "revision", "draft"} for key in offsets)
            or any(
                type(number) is not int or not 0 <= number <= 1_000_000
                for number in offsets.values()
            )
        ):
            raise ValueError
        return anchor, offsets, filters
    except (signing.BadSignature, KeyError, TypeError, ValueError):
        raise ValidationFailed("History cursor is invalid for these filters.") from None


def _filter(queryset, query, anchor, time, actor):
    queryset = queryset.filter(**{f"{time}__lte": anchor})
    if query.actor_id:
        queryset = queryset.filter(**{actor: query.actor_id})
    if query.from_date:
        queryset = queryset.filter(**{f"{time}__gte": query.from_date})
    if query.to_date:
        queryset = queryset.filter(**{f"{time}__lte": query.to_date})
    return queryset.order_by(f"-{time}", "-pk")


def _candidates(user, query, anchor, offsets):
    streams = {}
    if query.source in {"retained", "receipts"}:
        rows = (
            _filter(
                IdempotencyRecord.objects.filter(
                    scope=f"workspace:{query.workspace_id}", operation__in=RECEIPTS
                ),
                query,
                anchor,
                "created_at",
                "actor_id",
            )
            .annotate(
                revision_id=F("result__revision_id"),
                draft_id=F("result__draft_id"),
                definition_id=F("result__definition_id"),
                actor_name=F("actor__username"),
            )
            .values(
                "id",
                "operation",
                "created_at",
                "actor_id",
                "actor_name",
                "revision_id",
                "draft_id",
                "definition_id",
            )
        )
        start = offsets.get("receipt", 0)
        streams["receipt"] = [
            dict(row, at=row["created_at"], evidence="receipt")
            for row in rows[start : start + SCAN_LIMIT]
        ]
    if query.source in {"retained", "revisions"}:
        rows = Revision.objects.filter(definition__workspace_id=query.workspace_id)
        if query.kind:
            rows = rows.filter(definition__kind=query.kind)
        if query.definition_id:
            rows = rows.filter(definition_id=query.definition_id)
        rows = _filter(rows, query, anchor, "frozen_at", "frozen_by_id").values(
            "id", "frozen_at", actor_id=F("frozen_by_id"), actor_name=F("frozen_by__username")
        )
        start = offsets.get("revision", 0)
        streams["revision"] = [
            dict(row, at=row["frozen_at"], evidence="revision", revision_id=row["id"])
            for row in rows[start : start + SCAN_LIMIT]
        ]
    if query.source == "current_drafts":
        rows = Draft.objects.filter(definition__workspace_id=query.workspace_id)
        if query.kind:
            rows = rows.filter(definition__kind=query.kind)
        if query.definition_id:
            rows = rows.filter(definition_id=query.definition_id)
        rows = _filter(rows, query, anchor, "updated_at", "updated_by_id").values(
            "id", "updated_at", actor_id=F("updated_by_id"), actor_name=F("updated_by__username")
        )
        start = offsets.get("draft", 0)
        streams["draft"] = [
            dict(row, at=row["updated_at"], evidence="draft", draft_id=row["id"])
            for row in rows[start : start + SCAN_LIMIT]
        ]
    combined = sorted(
        (row for rows in streams.values() for row in rows),
        key=lambda row: (row["at"], row["evidence"], str(row["id"])),
        reverse=True,
    )
    return streams, combined[:SCAN_LIMIT]


def _readable_revisions(user, revisions):
    """Batch immutable closures, isolating denied subgroups without hiding clean rows."""
    readable = set()

    def check(group):
        if not group:
            return
        try:
            authorize_snapshots(user, [revision.snapshot for revision in group])
            readable.update(revision.id for revision in group)
        except OperationError:
            if len(group) > 1:
                middle = len(group) // 2
                check(group[:middle])
                check(group[middle:])

    check(list(revisions.values()))
    return readable


def list_history(user, query):
    authorize(user, query.workspace_id, Perm.WORKSPACE_READ)
    anchor, offsets, filters = _position(user, query)
    streams, candidates = _candidates(user, query, anchor, offsets)
    revision_ids = {_uuid(row.get("revision_id")) for row in candidates} - {None}
    draft_ids = {
        _uuid(row.get("draft_id")) for row in candidates if not _uuid(row.get("revision_id"))
    } - {None}
    revisions = Revision.objects.select_related("definition", "snapshot__definition").in_bulk(
        revision_ids
    )
    drafts = Draft.objects.select_related("definition").in_bulk(draft_ids)
    output = []
    consumed = {key: 0 for key in streams}
    with closure_reads():
        readable_revisions = _readable_revisions(user, revisions)
        for row in candidates:
            evidence = row["evidence"]
            consumed[evidence] += 1
            revision = revisions.get(_uuid(row.get("revision_id")))
            draft = drafts.get(_uuid(row.get("draft_id"))) if revision is None else None
            target = revision or draft
            if target is None or target.definition.workspace_id != query.workspace_id:
                continue
            if query.definition_id and target.definition_id != query.definition_id:
                continue
            if query.kind and target.definition.kind != query.kind:
                continue
            declared_definition = _uuid(row.get("definition_id"))
            if declared_definition and declared_definition != target.definition_id:
                continue
            try:
                if revision:
                    if revision.id not in readable_revisions:
                        continue
                else:
                    authorize_design_content(user, draft.definition, draft.content)
            except OperationError:
                continue
            touched = {
                "definition_id": str(target.definition_id),
                "kind": target.definition.kind,
                "name": target.definition.name,
                "basis": "exact_revision" if revision else "current_draft",
                "revision_id": str(revision.id) if revision else None,
                "number": revision.number if revision else None,
                "draft_id": str(draft.id) if draft else None,
                "state": draft.state_token if draft else None,
            }
            output.append(
                {
                    "event_id": f"{evidence}:{row['id']}",
                    "evidence": evidence,
                    "at": row["at"].isoformat(),
                    "actor": {"id": str(row["actor_id"]), "name": row["actor_name"]},
                    "operation": row.get("operation"),
                    "touched": [touched],
                }
            )
            if len(output) >= query.limit:
                break
    more = any(
        consumed[key] < len(rows) or len(rows) == SCAN_LIMIT for key, rows in streams.items()
    )
    after = (
        signing.dumps(
            {
                "actor": str(user.pk),
                "filters": filters,
                "anchor": anchor.isoformat(),
                "offsets": {key: offsets.get(key, 0) + consumed[key] for key in streams},
            },
            salt=SALT,
        )
        if more
        else None
    )
    return {
        "workspace_id": str(query.workspace_id),
        "as_of": anchor.isoformat(),
        "source": query.source,
        "hint": DRAFT_HINT if query.source == "current_drafts" else HINT,
        "complete_audit": False,
        "results": output,
        "next_after": after,
        "scan_limit_reached": sum(consumed.values()) >= SCAN_LIMIT and len(output) < query.limit,
    }
