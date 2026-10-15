"""Library search: find items for the command palette.

Read-only and bounded. Matches the item name, kind, manufacturer part numbers and source
identifiers of its exact revisions, and a connector body's declared family. Results are
ranked exact, then prefix, then substring, and within a rank by the field matched. Scans
are capped; a capped scan says so. Access is the library's: workspace read.
"""

from __future__ import annotations

import json

from django.db.models import Case, IntegerField, Value, When

from specmate.access.permissions import Perm
from specmate.catalog.models import ManufacturerVariant, SourceIdentifier
from specmate.design.models import Definition, Draft, Revision
from specmate.operations import Context, operation
from specmate.workspace.gallery_contracts import LibrarySearch, SearchLibrary
from specmate.workspace.queries import _actor, _workspace

FIELD_ORDER = {"name": 0, "part_number": 1, "identifier": 2, "connector_family": 3, "kind": 4}
CANDIDATES = 60
FAMILY_SCAN = 300


def _rank(value: str, query: str) -> int | None:
    folded, wanted = value.casefold(), query.casefold()
    if folded == wanted:
        return 0
    if folded.startswith(wanted):
        return 1
    return 2 if wanted in folded else None


def _consider(best: dict, definition_id, field: str, text: str, query: str) -> None:
    rank = _rank(text, query)
    if rank is None:
        return
    key = (rank, FIELD_ORDER[field])
    current = best.get(definition_id)
    if current is None or key < current[0]:
        best[definition_id] = (key, field, text)


def _connector_families(workspace) -> tuple[dict, bool]:
    """Declared family of each connector body: newest frozen content, else the newest draft."""
    definitions = list(
        Definition.objects.filter(workspace=workspace, kind="connector_body").order_by(
            "-created_at"
        )[: FAMILY_SCAN + 1]
    )
    capped = len(definitions) > FAMILY_SCAN
    ids = [definition.id for definition in definitions[:FAMILY_SCAN]]
    families = {}
    frozen = (
        Revision.objects.filter(definition_id__in=ids)
        .select_related("snapshot")
        .order_by("definition_id", "-number")
        .distinct("definition_id")
    )
    for revision in frozen:
        content = json.loads(bytes(revision.snapshot.canonical))["content"]
        families[revision.definition_id] = content.get("family")
    drafts = (
        Draft.objects.filter(definition_id__in=ids)
        .exclude(definition_id__in=list(families))
        .order_by("definition_id", "-updated_at", "-id")
        .distinct("definition_id")
        .values("definition_id", "content")
    )
    for draft in drafts:
        families[draft["definition_id"]] = (draft["content"] or {}).get("family")
    return {
        key: value for key, value in families.items() if isinstance(value, str) and value
    }, capped


def library_search(user, payload: SearchLibrary) -> dict:
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    query = payload.query
    best: dict = {}
    names = (
        Definition.objects.filter(workspace=workspace, name__icontains=query)
        .annotate(
            rank=Case(
                When(name__iexact=query, then=Value(0)),
                When(name__istartswith=query, then=Value(1)),
                default=Value(2),
                output_field=IntegerField(),
            )
        )
        .order_by("rank", "name")[: CANDIDATES + 1]
    )
    names = list(names)
    capped = len(names) > CANDIDATES
    for definition in names[:CANDIDATES]:
        _consider(best, definition.id, "name", definition.name, query)
    kinds = Definition.objects.filter(workspace=workspace)
    kind_filter = query.casefold().replace(" ", "_")
    for definition in kinds.filter(kind__icontains=kind_filter).order_by("name")[: CANDIDATES + 1]:
        _consider(best, definition.id, "kind", definition.kind.replace("_", " "), query)
    variants = ManufacturerVariant.objects.filter(
        revision__definition__workspace=workspace, part_number__icontains=query
    ).order_by("part_number")[: CANDIDATES + 1]
    for variant in list(variants)[:CANDIDATES]:
        _consider(best, variant.revision.definition_id, "part_number", variant.part_number, query)
    identifiers = SourceIdentifier.objects.filter(
        revision__definition__workspace=workspace, identifier__icontains=query
    ).order_by("identifier")[: CANDIDATES + 1]
    for identifier in list(identifiers)[:CANDIDATES]:
        _consider(
            best, identifier.revision.definition_id, "identifier", identifier.identifier, query
        )
    families, family_capped = _connector_families(workspace)
    capped = capped or family_capped
    for definition_id, family in families.items():
        _consider(best, definition_id, "connector_family", family, query)
    ranked = sorted(best.items(), key=lambda pair: pair[1][0])
    truncated = capped or len(ranked) > payload.limit
    ranked = ranked[: payload.limit]
    definitions = {d.id: d for d in Definition.objects.filter(id__in=[key for key, _ in ranked])}
    latest = {
        revision.definition_id: revision
        for revision in Revision.objects.filter(definition_id__in=list(definitions))
        .order_by("definition_id", "-number")
        .distinct("definition_id")
    }
    results = []
    for definition_id, ((rank, _), field, text) in ranked:
        definition = definitions[definition_id]
        revision = latest.get(definition_id)
        results.append(
            {
                "record_id": definition.id,
                "kind": definition.kind,
                "label": definition.name,
                "created_at": definition.created_at,
                "latest_revision": revision.number if revision else None,
                "latest_revision_id": revision.id if revision else None,
                "changed_at": None,
                "match": {"field": field, "text": text, "rank": rank},
            }
        )
    return LibrarySearch(
        workspace_id=workspace.id, query=query, results=results, truncated=truncated
    ).model_dump(mode="json")


@operation(
    "library.search",
    SearchLibrary,
    summary="Find library items by name, kind, manufacturer part number or source identifier "
    "and connector family, ranked exact, prefix, substring. Bounded and read-only; the "
    "result is the whole workspace library, as the library list is.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def search(ctx: Context, p: SearchLibrary) -> dict:
    return library_search(ctx.user, p)
