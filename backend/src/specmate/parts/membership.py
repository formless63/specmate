"""Bounded exact kit memberships; catalog grouping never implies a physical occurrence."""

import json

from django.core import signing
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from specmate.access.permissions import Perm
from specmate.catalog_matching.queries import current_actor
from specmate.design.closure_reads import closure_reads
from specmate.design.models import Revision
from specmate.operations import Context, ValidationFailed, operation
from specmate.parts.contracts import Kit, ReadKits
from specmate.parts.queries import ITEM_KINDS, readable_revisions
from specmate.queries import get_revision

SALT = "catalog-kit-membership-v1"
SCAN_LIMIT = 50


def position(after, revision_id):
    if after is None:
        return timezone.now(), 0
    try:
        cursor = signing.loads(after, salt=SALT, max_age=86400)
        anchor, offset = parse_datetime(cursor["anchor"]), cursor["offset"]
        if (
            type(cursor["version"]) is not int
            or cursor["version"] != 1
            or cursor["root"] != str(revision_id)
            or anchor is None
            or timezone.is_naive(anchor)
            or anchor > timezone.now()
            or type(offset) is not int
            or not 0 <= offset <= 1_000_000
        ):
            raise ValueError
        return anchor, offset
    except (signing.BadSignature, KeyError, TypeError, ValueError):
        raise ValidationFailed("Invalid kit membership cursor.") from None


def kits_for_revision(user, revision_id, query):
    user = current_actor(user)
    selected = get_revision(user, revision_id)
    if selected.definition.kind not in ITEM_KINDS:
        raise ValidationFailed("Kit membership requires an exact physical catalog design.")
    anchor, offset = position(query.after, selected.id)
    candidates = list(
        Revision.objects.filter(
            definition__workspace_id=selected.definition.workspace_id,
            definition__kind="kit",
            snapshot__dependencies__revision=selected,
            frozen_at__lte=anchor,
        )
        .select_related("definition", "snapshot__definition")
        .order_by("-frozen_at", "id")[offset : offset + SCAN_LIMIT + 1]
    )
    batch = candidates[:SCAN_LIMIT]
    with closure_reads():
        readable = readable_revisions(user, batch)
    scanned, results = 0, []
    for candidate in batch:
        scanned += 1
        if candidate.id not in readable:
            continue
        kit = Kit.model_validate(json.loads(bytes(candidate.snapshot.canonical))["content"]["kit"])
        lines = [
            line.model_dump(mode="json") for line in kit.lines if line.revision_id == selected.id
        ]
        if not lines:
            continue
        results.append(
            {
                "definition_id": str(candidate.definition_id),
                "revision_id": str(candidate.id),
                "number": candidate.number,
                "name": candidate.definition.name,
                "lines": lines,
            }
        )
        if len(results) == query.limit:
            break
    return {
        "revision_id": str(selected.id),
        "results": results,
        "next_after": signing.dumps(
            {
                "version": 1,
                "root": str(selected.id),
                "anchor": anchor.isoformat(),
                "offset": offset + scanned,
            },
            salt=SALT,
            compress=True,
        )
        if len(candidates) > scanned
        else None,
        "semantics": "catalog_grouping",
        "basis": "exact_declared_lines",
        "physical_assembly": "not_implied",
        "listing": "current_readable_page_no_hidden_total",
    }


@operation(
    "catalog.kits_for_revision",
    ReadKits,
    supports_idempotency=False,
    summary="Read a bounded page of freshly authorized exact catalog kit memberships.",
    access=Perm.WORKSPACE_READ,
)
def read_kits(ctx: Context, payload: ReadKits):
    return kits_for_revision(ctx.user, payload.revision_id, payload)
