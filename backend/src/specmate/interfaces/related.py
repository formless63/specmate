"""Bounded, freshly authorized connector relations; exact pins never imply compatibility."""

import json
from uuid import UUID

from django.core import signing
from django.db.models import Exists, OuterRef, Subquery
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from pydantic import Field

from specmate.assemblies.contracts import StrictModel
from specmate.design.closure_reads import closure_reads, prefetch_origins
from specmate.design.models import Revision, SnapshotDependency
from specmate.interfaces.contracts import ConnectorBody, Pinout, Port
from specmate.interfaces.end_assembly_contracts import EndAssembly
from specmate.interfaces.queries import Closure, parse_content, read_revision
from specmate.operations import OperationError, ValidationFailed

KINDS = ("pinout", "port", "end_assembly")
SCAN_LIMIT = 50
SALT = "interface-related-page-v1"


class RelatedQuery(StrictModel):
    after: str | None = Field(default=None, max_length=2000)
    limit: int = Field(default=20, ge=1, le=50)


class ReadConnectorRelations(RelatedQuery):
    revision_id: UUID


def _position(after, revision_id):
    if after is None:
        return timezone.now(), 0
    try:
        cursor = signing.loads(after, salt=SALT, max_age=86400)
        anchor = parse_datetime(cursor["anchor"])
        offset = cursor["offset"]
        if (
            cursor["body"] != str(revision_id)
            or anchor is None
            or timezone.is_naive(anchor)
            or anchor > timezone.now()
            or type(offset) is not int
            or not 0 <= offset <= 1_000_000
        ):
            raise ValueError
        return anchor, offset
    except (signing.BadSignature, KeyError, TypeError, ValueError):
        raise ValidationFailed("Invalid connector relation cursor.") from None


def _authorized(user, root, rows):
    """Authorize common dependency levels together, isolating denied subgroups.

    A failed group publishes no content. Successful groups share one fresh closure
    traversal instead of loading every row through a separate inspection endpoint.
    """
    if not rows:
        return set()
    try:
        Closure(
            user,
            {"interface": root.model_dump(mode="json")},
            "connector_body",
            [row.id for row in rows],
        )
        return {row.id for row in rows}
    except OperationError:
        if len(rows) == 1:
            return set()
        middle = len(rows) // 2
        return _authorized(user, root, rows[:middle]) | _authorized(user, root, rows[middle:])


def connector_relations(user, revision_id: UUID, query: RelatedQuery):
    selected, closure = read_revision(user, revision_id)
    if not isinstance(closure.root, ConnectorBody):
        raise ValidationFailed("Connector relations require an exact body revision.")
    anchor, offset = _position(query.after, selected.id)
    latest = (
        Revision.objects.filter(definition_id=OuterRef("definition_id"), frozen_at__lte=anchor)
        .order_by("-number")
        .values("id")[:1]
    )
    depends_on_body = SnapshotDependency.objects.filter(
        snapshot_id=OuterRef("snapshot_id"),
        revision__definition_id=selected.definition_id,
    )
    candidates = (
        Revision.objects.filter(
            definition__workspace_id=selected.definition.workspace_id,
            definition__kind__in=KINDS,
            frozen_at__lte=anchor,
        )
        .annotate(has_body=Exists(depends_on_body))
        .filter(id=Subquery(latest), has_body=True)
        .select_related("definition", "snapshot__definition")
        .order_by("definition__kind", "definition_id")
    )
    page = list(candidates[offset : offset + SCAN_LIMIT + 1])
    batch = page[:SCAN_LIMIT]
    with closure_reads():
        prefetch_origins([row.definition_id for row in batch])
        permitted = _authorized(user, closure.root, batch)
    # Only the bounded page's canonical content is decoded. Pinout rows needed by
    # ports are loaded together, not with a per-port read or a whole-library scan.
    values = {
        row.id: parse_content(
            json.loads(bytes(row.snapshot.canonical))["content"], row.definition.kind
        )
        for row in batch
        if row.id in permitted
    }
    pinout_ids = [value.pinout_revision_id for value in values.values() if isinstance(value, Port)]
    pinouts = {
        row.id: parse_content(json.loads(bytes(row.snapshot.canonical))["content"], "pinout")
        for row in Revision.objects.filter(id__in=pinout_ids).select_related("snapshot")
    }
    ours = {
        str(value)
        for value in Revision.objects.filter(definition_id=selected.definition_id).values_list(
            "id", flat=True
        )
    }
    results = []
    scanned = 0
    for row in batch:
        scanned += 1
        value = values.get(row.id)
        pins = []
        if isinstance(value, Pinout):
            pins = [value.body_revision_id]
        elif isinstance(value, Port):
            variant = pinouts.get(value.pinout_revision_id)
            if isinstance(variant, Pinout):
                pins = [variant.body_revision_id]
        elif isinstance(value, EndAssembly):
            pins = [
                layer.body_revision_id for layer in value.stack.layers if layer.kind == "connector"
            ]
        pins = sorted({str(pin) for pin in pins if str(pin) in ours})
        if not pins:
            continue  # A transitive mating dependency is not a direct body association.
        results.append(
            {
                "definition_id": str(row.definition_id),
                "name": row.definition.name,
                "kind": row.definition.kind,
                "revision_id": str(row.id),
                "number": row.number,
                "body_revision_ids": pins,
                "uses_selected_body_revision": str(selected.id) in pins,
                "uses_other_body_revision": any(pin != str(selected.id) for pin in pins),
            }
        )
        if len(results) == query.limit:
            break
    more = len(page) > scanned
    after = (
        signing.dumps(
            {"body": str(selected.id), "anchor": anchor.isoformat(), "offset": offset + scanned},
            salt=SALT,
            compress=True,
        )
        if more
        else None
    )
    return {
        "body_definition_id": str(selected.definition_id),
        "body_revision_id": str(selected.id),
        "body_revision_number": selected.number,
        "basis": "latest_frozen_at_page_anchor",
        "as_of": anchor.isoformat(),
        "results": results,
        "next_after": after,
        "scan_limit_reached": scanned == SCAN_LIMIT and more,
        "compatibility": "not_evaluated",
        "listing": "bounded_candidates_no_hidden_total",
    }
