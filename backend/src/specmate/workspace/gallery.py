"""Library home reads: what needs attention, the actor's recent work and card previews.

Read-only aggregation over records that already exist. Attention comes from:

- the latest recorded check of each cable or interface assessment (failing and unknown
  rows or findings, exactly as recorded; nothing is re-evaluated here);
- staleness of that latest record (a pinned input revision has a newer revision);
- open questions in cable intent drafts;
- declared values recorded with status "unknown" in interface content.

Every read is bounded by a fixed scan size and a fixed number of queries. A workspace
that has more records than were scanned says so; totals are then lower bounds.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import timedelta
from uuid import UUID

from django.db.models import Count, Max, OuterRef, Subquery

from specmate.access.permissions import Perm
from specmate.design.models import Definition, Draft, Revision
from specmate.evidence.models import RecordedPin, RecordedResult
from specmate.operations import Context, operation
from specmate.workspace.contracts import KindCount
from specmate.workspace.gallery_contracts import (
    AttentionItem,
    AttentionReason,
    AttentionTotals,
    LibraryHome,
    LibraryPreview,
    LibraryPreviews,
    ReadLibraryHome,
    ReadLibraryPreviews,
    RecentItem,
)
from specmate.workspace.queries import _actor, _workspace

RECORD_SCAN = 500
DRAFT_SCAN = 2000
PREVIEW_BYTES = 64 * 1024
UNKNOWN_DEPTH = 12
FREEZE_TOUCH = timedelta(seconds=2)
# Kinds whose content declares values with an explicit known/unknown status.
DECLARING_KINDS = (
    "signal_set",
    "port",
    "pinout",
    "connector_body",
    "board",
    "end_assembly",
    "conductor_convention",
    "cable_intent",
    "interface_map",
)
SUBJECT_ROLES = {"cable": "cable", "assessment": "assessment"}
SEVERITY = {"fail": 0, "review": 1, "unknown": 2}
REASON_STATUS = {
    "failing_check": "fail",
    "open_questions": "review",
    "stale_evidence": "review",
    "unknown_check": "unknown",
    "unknown_values": "unknown",
}
ACTIONABLE = {"failing_check", "open_questions", "stale_evidence"}


def _plural(count: int, one: str, many: str | None = None) -> str:
    return f"{count} {one if count == 1 else (many or one + 's')}"


def _content(revision: Revision) -> dict:
    return json.loads(bytes(revision.snapshot.canonical))["content"]


def _record_counts(record: RecordedResult) -> tuple[int, int]:
    """(failing, unknown) rows or findings of one recorded result, as recorded."""
    result = record.result or {}
    if record.source == RecordedResult.Source.CABLE_INTENT_CHECK:
        counts = Counter(row.get("outcome") for row in result.get("rows", []))
        return counts["fail"], counts["unknown"]
    if record.source == RecordedResult.Source.INTERFACE_ASSESSMENT:
        findings = (result.get("assessment") or {}).get("findings", [])
        counts = Counter(finding.get("status") for finding in findings)
        return counts["invalid"], counts["unknown"]
    return 0, 0


def _evidence_reasons(workspace_id) -> tuple[dict, bool]:
    """Reasons per subject definition from the latest recorded result about it."""
    records = list(
        RecordedResult.objects.filter(workspace_id=workspace_id)
        .exclude(source=RecordedResult.Source.FIRMWARE_IMPACT)
        .order_by("-recorded_at", "-id")[: RECORD_SCAN + 1]
    )
    limited = len(records) > RECORD_SCAN
    records = records[:RECORD_SCAN]
    pins = defaultdict(list)
    for pin in RecordedPin.objects.filter(record__in=records).select_related("revision"):
        pins[pin.record_id].append(pin)
    definitions = {pin.revision.definition_id for rows in pins.values() for pin in rows}
    latest = dict(
        Revision.objects.filter(definition_id__in=definitions)
        .order_by()
        .values("definition_id")
        .annotate(n=Max("number"))
        .values_list("definition_id", "n")
    )
    reasons: dict = defaultdict(list)
    seen = set()
    for record in records:
        subject = next((p for p in pins[record.id] if p.role in SUBJECT_ROLES), None)
        if subject is None:
            continue
        definition = subject.revision.definition_id
        if definition in seen:
            continue  # Only the latest record about a subject speaks for it.
        seen.add(definition)
        failing, unknown = _record_counts(record)
        noun = "row" if record.source == RecordedResult.Source.CABLE_INTENT_CHECK else "finding"
        if failing:
            reasons[definition].append(
                AttentionReason(
                    kind="failing_check",
                    count=failing,
                    detail=f"{_plural(failing, noun)} {'fails' if failing == 1 else 'fail'}",
                )
            )
        if unknown:
            reasons[definition].append(
                AttentionReason(
                    kind="unknown_check",
                    count=unknown,
                    detail=f"{_plural(unknown, noun)} unknown",
                )
            )
        pinned = pins[record.id]
        if any(latest.get(p.revision.definition_id, 0) > p.revision.number for p in pinned):
            reasons[definition].append(
                AttentionReason(
                    kind="stale_evidence",
                    count=1,
                    detail="recorded check predates a newer pinned revision",
                )
            )
    return reasons, limited


def _count_unknown(value, depth: int = 0) -> int:
    if depth > UNKNOWN_DEPTH:
        return 0
    if isinstance(value, dict):
        own = 1 if value.get("status") == "unknown" else 0
        return own + sum(_count_unknown(item, depth + 1) for item in value.values())
    if isinstance(value, list):
        return sum(_count_unknown(item, depth + 1) for item in value)
    return 0


def _draft_reasons(workspace_id) -> tuple[dict, bool]:
    """Open intent questions and declared unknown values from each newest draft."""
    drafts = list(
        Draft.objects.filter(
            definition__workspace_id=workspace_id, definition__kind__in=DECLARING_KINDS
        )
        .order_by("definition_id", "-updated_at", "-id")
        .distinct("definition_id")
        .values("definition_id", "definition__kind", "content")[: DRAFT_SCAN + 1]
    )
    limited = len(drafts) > DRAFT_SCAN
    reasons: dict = defaultdict(list)
    for draft in drafts[:DRAFT_SCAN]:
        interface = (draft["content"] or {}).get("interface") or {}
        if draft["definition__kind"] == "cable_intent":
            questions = sum(1 for row in interface.get("rows", []) if row.get("question"))
            if questions:
                reasons[draft["definition_id"]].append(
                    AttentionReason(
                        kind="open_questions",
                        count=questions,
                        detail=f"{_plural(questions, 'open question')}",
                    )
                )
        unknown = _count_unknown(interface)
        if unknown:
            reasons[draft["definition_id"]].append(
                AttentionReason(
                    kind="unknown_values",
                    count=unknown,
                    detail=f"{_plural(unknown, 'declared value')} unknown",
                )
            )
    return reasons, limited


def _items(workspace_id, ids) -> dict:
    latest = Revision.objects.filter(definition=OuterRef("pk")).order_by("-number")
    changed = Draft.objects.filter(definition=OuterRef("pk")).order_by("-updated_at")
    rows = Definition.objects.filter(workspace_id=workspace_id, id__in=ids).annotate(
        latest_revision=Subquery(latest.values("number")[:1]),
        latest_revision_id=Subquery(latest.values("id")[:1]),
        changed_at=Subquery(changed.values("updated_at")[:1]),
    )
    return {
        row.id: {
            "record_id": row.id,
            "kind": row.kind,
            "label": row.name,
            "created_at": row.created_at,
            "latest_revision": row.latest_revision,
            "latest_revision_id": row.latest_revision_id,
            "changed_at": row.changed_at,
        }
        for row in rows
    }


def _recent(actor, workspace_id, limit: int) -> list[tuple]:
    edits = (
        Draft.objects.filter(definition__workspace_id=workspace_id, updated_by=actor)
        .order_by("-updated_at", "-id")
        .values_list("definition_id", "updated_at")[: limit * 3]
    )
    freezes = (
        Revision.objects.filter(definition__workspace_id=workspace_id, frozen_by=actor)
        .order_by("-frozen_at", "-id")
        .values_list("definition_id", "frozen_at")[: limit * 3]
    )
    frozen_at = defaultdict(list)
    for definition, at in freezes:
        frozen_at[definition].append(at)

    def bookkeeping(definition, at) -> bool:
        # Freezing also touches the draft; that touch is the freeze, not a separate edit.
        return any(timedelta(0) <= at - when < FREEZE_TOUCH for when in frozen_at[definition])

    events = sorted(
        [(at, d, "edited") for d, at in edits if not bookkeeping(d, at)]
        + [(at, d, "frozen") for d, at in freezes],
        key=lambda event: event[0],
        reverse=True,
    )
    result, seen = [], set()
    for at, definition, activity in events:
        if definition in seen:
            continue
        seen.add(definition)
        result.append((definition, activity, at))
        if len(result) == limit:
            break
    return result


def library_home(user, payload: ReadLibraryHome) -> dict:
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    evidence, evidence_limited = _evidence_reasons(workspace.id)
    drafts, drafts_limited = _draft_reasons(workspace.id)
    reasons: dict = defaultdict(list)
    for source in (evidence, drafts):
        for definition, found in source.items():
            reasons[definition].extend(found)
    totals = Counter()
    for found in reasons.values():
        for reason in found:
            totals[reason.kind] += reason.count
    order = list(REASON_STATUS)

    def rank(definition):
        found = reasons[definition]
        return (
            min(SEVERITY[REASON_STATUS[r.kind]] for r in found),
            min(order.index(r.kind) for r in found),
            -sum(r.count for r in found),
            str(definition),
        )

    # Attention is what someone must act on: a failing recorded check, an open intent
    # question or a stale record. Unknowns alone are listed separately.
    flagged = sorted(
        (d for d in reasons if any(r.kind in ACTIONABLE for r in reasons[d])), key=rank
    )
    unknown = sorted((d for d in reasons if d not in set(flagged)), key=rank)
    recent = _recent(actor, workspace.id, payload.limit)
    shown, shown_unknown = flagged[: payload.limit], unknown[: payload.limit]
    items = _items(
        workspace.id,
        set(shown) | set(shown_unknown) | {definition for definition, _, _ in recent},
    )

    def card(definition):
        found = sorted(reasons[definition], key=lambda r: order.index(r.kind))
        status = min((REASON_STATUS[r.kind] for r in found), key=SEVERITY.__getitem__)
        return AttentionItem(**items[definition], status=status, reasons=found)

    # A pin to another workspace's revision never names it here.
    attention = [card(d) for d in shown if d in items]
    unknowns = [card(d) for d in shown_unknown if d in items]
    kinds = (
        Definition.objects.filter(workspace=workspace)
        .order_by()
        .values("kind")
        .annotate(n=Count("id"))
        .order_by("kind")
    )
    kind_counts = [KindCount(kind=row["kind"], count=row["n"]) for row in kinds]
    return LibraryHome(
        workspace_id=workspace.id,
        attention=attention,
        attention_total=len(flagged),
        unknowns=unknowns,
        unknowns_total=len(unknown),
        recent=[
            RecentItem(**items[definition], activity=activity, at=at)
            for definition, activity, at in recent
            if definition in items
        ],
        totals=AttentionTotals(
            failing_checks=totals["failing_check"],
            unknown_checks=totals["unknown_check"],
            open_questions=totals["open_questions"],
            stale_evidence=totals["stale_evidence"],
            unknown_values=totals["unknown_values"],
        ),
        kinds=kind_counts,
        definitions_total=sum(row.count for row in kind_counts),
        scan_limit_reached=evidence_limited or drafts_limited,
    ).model_dump(mode="json")


def _bounded(content) -> tuple[dict | None, bool]:
    if content is None:
        return None, False
    size = len(json.dumps(content, separators=(",", ":"), default=str))
    return (None, True) if size > PREVIEW_BYTES else (content, False)


def _stock_ids(content) -> UUID | None:
    cable = (content or {}).get("cable") if isinstance(content, dict) else None
    value = cable.get("stock_revision_id") if isinstance(cable, dict) else None
    try:
        return UUID(str(value)) if value else None
    except ValueError:
        return None


def _uuid(value) -> UUID | None:
    try:
        return UUID(str(value)) if value else None
    except ValueError:
        return None


def _interfaces(workspace, ids, kind) -> dict:
    """Interface content of this workspace's revisions of one kind, by revision id."""
    ids = [value for value in ids if value]
    if not ids:
        return {}
    rows = Revision.objects.filter(
        id__in=ids, definition__workspace=workspace, definition__kind=kind
    ).select_related("snapshot")
    return {row.id: _content(row).get("interface") for row in rows}


def _faces(workspace, contents, definitions) -> dict:
    """For pinouts and ports: the pinned body, the port's pinout and the signal types used."""
    interface = {
        d.id: ((contents[d.id][2] or {}).get("interface") or {})
        for d in definitions
        if d.kind in ("pinout", "port")
    }
    pinout_ids = {
        d: _uuid(value.get("pinout_revision_id"))
        for d, value in interface.items()
        if value.get("kind") == "port"
    }
    pinouts = _interfaces(workspace, pinout_ids.values(), "pinout")
    pinout_of = {
        d: (value if value.get("kind") == "pinout" else pinouts.get(pinout_ids.get(d)))
        for d, value in interface.items()
    }
    bodies = _interfaces(
        workspace,
        [_uuid((p or {}).get("body_revision_id")) for p in pinout_of.values()],
        "connector_body",
    )
    refs = {
        _uuid((a.get("electrical") or {}).get("signal_ref", {}).get("signal_set_revision_id"))
        for p in pinout_of.values()
        for a in (p or {}).get("assignments", [])
        if isinstance((a.get("electrical") or {}).get("signal_ref"), dict)
    }
    sets = _interfaces(workspace, refs, "signal_set")
    types = {
        f"{revision}/{signal.get('key')}": signal.get("type", "unknown")
        for revision, value in sets.items()
        for signal in (value or {}).get("signals", [])
    }
    result = {}
    for d, pinout in pinout_of.items():
        if not pinout:
            result[d] = (None, None, {})
            continue
        used = {}
        for a in pinout.get("assignments", []):
            ref = (a.get("electrical") or {}).get("signal_ref")
            if isinstance(ref, dict):
                key = f"{ref.get('signal_set_revision_id')}/{ref.get('key')}"
                if key in types:
                    used[key] = types[key]
        body = bodies.get(_uuid(pinout.get("body_revision_id")))
        result[d] = (body, pinout if interface[d].get("kind") == "port" else None, used)
    return result


def library_previews(user, payload: ReadLibraryPreviews) -> dict:
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    definitions = list(
        Definition.objects.filter(workspace=workspace, id__in=set(payload.definition_ids))
    )
    ids = [definition.id for definition in definitions]
    revisions = {
        revision.definition_id: revision
        for revision in Revision.objects.filter(definition_id__in=ids)
        .select_related("snapshot")
        .order_by("definition_id", "-number")
        .distinct("definition_id")
    }
    drafts = {
        draft["definition_id"]: draft
        for draft in Draft.objects.filter(definition_id__in=ids)
        .exclude(definition_id__in=list(revisions))
        .order_by("definition_id", "-updated_at", "-id")
        .distinct("definition_id")
        .values("definition_id", "content", "version")
    }
    contents = {}
    for definition in definitions:
        if definition.id in revisions:
            revision = revisions[definition.id]
            contents[definition.id] = ("revision", revision.number, _content(revision))
        elif definition.id in drafts:
            contents[definition.id] = ("draft", None, drafts[definition.id]["content"])
        else:
            contents[definition.id] = ("none", None, None)
    stock_ids = {
        definition.id: _stock_ids(contents[definition.id][2])
        for definition in definitions
        if definition.kind == "cable"
    }
    # Only stock revisions of this workspace are resolved; another workspace's stays absent.
    stocks = {
        revision.id: _content(revision).get("stock")
        for revision in Revision.objects.filter(
            id__in=[value for value in stock_ids.values() if value],
            definition__workspace=workspace,
            definition__kind="wire_stock",
        ).select_related("snapshot")
    }
    faces = _faces(workspace, contents, definitions)
    order = {value: index for index, value in enumerate(payload.definition_ids)}
    previews = []
    for definition in sorted(definitions, key=lambda d: order[d.id]):
        source, number, content = contents[definition.id]
        bounded, truncated = _bounded(content)
        stock, _ = _bounded(stocks.get(stock_ids.get(definition.id)))
        body, pinout, signal_types = faces.get(definition.id, (None, None, {}))
        previews.append(
            LibraryPreview(
                record_id=definition.id,
                kind=definition.kind,
                source=source,
                revision=number,
                draft_version=drafts[definition.id]["version"] if source == "draft" else None,
                content=bounded,
                truncated=truncated,
                stock=stock,
                body=_bounded(body)[0],
                pinout=_bounded(pinout)[0],
                signal_types=signal_types,
            )
        )
    return LibraryPreviews(workspace_id=workspace.id, previews=previews).model_dump(mode="json")


@operation(
    "library.home",
    ReadLibraryHome,
    summary="Read the Library home: items needing attention (failing recorded checks, open "
    "intent questions, stale evidence), items with unknowns only, the actor's recent work "
    "and definition counts by kind. Read-only; nothing is evaluated afresh.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_home(ctx: Context, p: ReadLibraryHome) -> dict:
    return library_home(ctx.user, p)


@operation(
    "library.previews",
    ReadLibraryPreviews,
    summary="Read compact newest content (latest frozen revision, else newest draft) of up "
    "to 50 library definitions, with a cable's pinned stock, for drawing gallery cards.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_previews(ctx: Context, p: ReadLibraryPreviews) -> dict:
    return library_previews(ctx.user, p)
