"""Bounded frozen designs by their exact retained intent's device-port pair."""

import json
from uuid import UUID

from django.core import signing
from django.db.models import Exists, OuterRef, Subquery
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from pydantic import Field

from specmate.assemblies.contracts import StrictModel
from specmate.cables.queries import parse_content
from specmate.design.closure_reads import closure_reads, prefetch_origins
from specmate.design.models import Revision, Snapshot, SnapshotDependency
from specmate.design.operations import authorize_snapshots
from specmate.interfaces.contracts import Port
from specmate.interfaces.intent_contracts import CableIntent
from specmate.interfaces.queries import parse_content as parse_interface
from specmate.interfaces.queries import read_revision
from specmate.operations import NotFound, OperationError, ValidationFailed

SCAN_LIMIT = 50
SALT = "cable-connections-v1"


class ConnectionsQuery(StrictModel):
    from_revision_id: UUID
    to_revision_id: UUID
    limit: int = Field(default=20, ge=1, le=50)
    after: str | None = Field(default=None, max_length=3000)


def _position(user, workspace_id, query):
    filters = {
        "workspace": str(workspace_id),
        **query.model_dump(mode="json", exclude={"limit", "after"}),
    }
    if not query.after:
        return timezone.now(), 0, filters
    try:
        cursor = signing.loads(query.after, salt=SALT, max_age=86400)
        anchor = parse_datetime(cursor["anchor"])
        offset = cursor["offset"]
        if (
            cursor["actor"] != str(user.pk)
            or cursor["filters"] != filters
            or anchor is None
            or timezone.is_naive(anchor)
            or anchor > timezone.now()
            or type(offset) is not int
            or not 0 <= offset <= 1_000_000
        ):
            raise ValueError
        return anchor, offset, filters
    except (signing.BadSignature, KeyError, TypeError, ValueError):
        raise ValidationFailed("Invalid frozen connection cursor.") from None


def _authorized(user, snapshots):
    if not snapshots:
        return set()
    try:
        authorize_snapshots(user, snapshots)
        return {row.id for row in snapshots}
    except OperationError:
        if len(snapshots) == 1:
            return set()
        middle = len(snapshots) // 2
        return _authorized(user, snapshots[:middle]) | _authorized(user, snapshots[middle:])


def connections(user, query: ConnectionsQuery):
    source, left = read_revision(user, query.from_revision_id)
    target, right = read_revision(user, query.to_revision_id)
    if source.definition.workspace_id != target.definition.workspace_id:
        raise NotFound("Device port pair unavailable.")
    if not isinstance(left.root, Port) or not isinstance(right.root, Port):
        raise ValidationFailed("Choose two exact device port revisions, not bare pinouts.")
    workspace_id = source.definition.workspace_id
    anchor, offset, filters = _position(user, workspace_id, query)
    # Both pins must belong to this same retained intent. No latest-intent substitution.
    intents = Revision.objects.filter(
        definition__workspace_id=workspace_id, definition__kind="cable_intent"
    )
    intents = intents.filter(snapshot__dependencies__revision__definition_id=source.definition_id)
    intents = intents.filter(snapshot__dependencies__revision__definition_id=target.definition_id)
    has_intent = SnapshotDependency.objects.filter(
        snapshot_id=OuterRef("snapshot_id"), revision_id__in=intents.values("id")
    )
    latest = (
        Revision.objects.filter(definition_id=OuterRef("definition_id"), frozen_at__lte=anchor)
        .order_by("-number")
        .values("id")[:1]
    )
    page = list(
        Revision.objects.filter(
            definition__workspace_id=workspace_id, definition__kind="cable", frozen_at__lte=anchor
        )
        .annotate(has_intent=Exists(has_intent))
        .filter(id=Subquery(latest), has_intent=True)
        .order_by("definition_id")
        .values("id", "definition_id", "number", "snapshot_id", "definition__name")[
            offset : offset + SCAN_LIMIT + 1
        ]
    )
    batch = page[:SCAN_LIMIT]
    snapshots = list(
        Snapshot.objects.filter(id__in=[row["snapshot_id"] for row in batch]).select_related(
            "definition"
        )
    )
    with closure_reads():
        prefetch_origins([row["definition_id"] for row in batch])
        readable = _authorized(user, snapshots)
    values = {
        row.id: parse_content(json.loads(bytes(row.canonical))["content"], "cable")
        for row in snapshots
        if row.id in readable
    }
    pinned = {
        value.intent_revision_id for value in values.values() if value and value.intent_revision_id
    }
    intent_values = {
        row.id: parse_interface(
            json.loads(bytes(row.snapshot.canonical))["content"], "cable_intent"
        )
        for row in Revision.objects.filter(
            id__in=pinned, definition__kind="cable_intent"
        ).select_related("snapshot")
    }
    ends = {
        pin
        for value in intent_values.values()
        if isinstance(value, CableIntent)
        for pin in (value.from_revision_id, value.to_revision_id)
    }
    port_definitions = dict(
        Revision.objects.filter(
            id__in=ends, definition__workspace_id=workspace_id, definition__kind="port"
        ).values_list("id", "definition_id")
    )
    pair = (source.definition_id, target.definition_id)
    results, scanned = [], 0
    for row in batch:
        scanned += 1
        cable = values.get(row["snapshot_id"])
        intent = intent_values.get(cable.intent_revision_id) if cable else None
        if not isinstance(intent, CableIntent):
            continue
        actual = (
            port_definitions.get(intent.from_revision_id),
            port_definitions.get(intent.to_revision_id),
        )
        if actual != pair and actual != pair[::-1]:
            continue
        pins = (intent.from_revision_id, intent.to_revision_id)
        selected = (source.id, target.id)
        exact = pins == selected or pins == selected[::-1]
        orientation = "from_to" if actual == pair else "to_from"
        if pair[0] == pair[1]:
            orientation = (
                "from_to"
                if pins == selected
                else "to_from"
                if pins == selected[::-1]
                else "same_port_definition"
            )
        results.append(
            {
                "definition_id": str(row["definition_id"]),
                "name": row["definition__name"],
                "revision_id": str(row["id"]),
                "number": row["number"],
                "intent_revision_id": str(cable.intent_revision_id),
                "from_revision_id": str(intent.from_revision_id),
                "to_revision_id": str(intent.to_revision_id),
                "orientation": orientation,
                "uses_selected_port_revisions": exact,
                "uses_other_port_revisions": not exact,
            }
        )
        if len(results) == query.limit:
            break
    more = scanned < len(page)
    after = (
        signing.dumps(
            {
                "actor": str(user.pk),
                "filters": filters,
                "anchor": anchor.isoformat(),
                "offset": offset + scanned,
            },
            salt=SALT,
        )
        if more
        else None
    )
    return {
        "workspace_id": str(workspace_id),
        "from_revision_id": str(source.id),
        "to_revision_id": str(target.id),
        "label": "Frozen designs connecting these ports",
        "basis": "latest_frozen_at_page_anchor",
        "as_of": anchor.isoformat(),
        "results": results,
        "next_after": after,
        "scan_limit_reached": scanned == SCAN_LIMIT and more,
        "compatibility": "not_evaluated",
        "listing": "bounded_candidates_no_hidden_total",
    }
