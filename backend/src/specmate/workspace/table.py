"""Batched compact Library projection, selected exact state before content loads.

No source bytes or representations are returned. Manufacturer numbers describe only
an exact revision; a later draft or freeze cannot change the selected row's basis.
"""

import json
from collections import defaultdict

from django.db.models import (
    Exists,
    F,
    Func,
    JSONField,
    OuterRef,
    Q,
    Subquery,
    TextField,
    Value,
    Window,
)
from django.db.models.functions import Cast, RowNumber

from specmate.catalog.models import ManufacturerVariant
from specmate.design.closure_reads import closure_reads, prefetch_origins
from specmate.design.models import Draft, Revision
from specmate.design.operations import authorize_design_content
from specmate.operations import OperationError
from specmate.parts.queries import readable_revisions
from specmate.workspace.contracts import ListLibrary
from specmate.workspace.queries import (
    _actor,
    _context,
    _definitions,
    _encode,
    _page_after,
    _records,
    _referenced_flag,
    _workspace,
)
from specmate.workspace.table_contracts import (
    LibraryField,
    LibraryNumber,
    LibrarySummary,
    LibraryTablePage,
    LibraryTableRecord,
    ListLibraryTable,
)


def _fields(kind, content):
    """Only typed declarations are summarized; absent payload is an unfinished draft."""
    interface = content.get("interface") or {}
    values = []

    def field(key, label, value=None, unit=None):
        values.append(LibraryField(key=key, label=label, value=value, unit=unit))

    def count(key):
        value = interface.get(key)
        return len(value) if isinstance(value, list) else None

    if kind == "connector_body":
        field("family", "Family", interface.get("family"))
        field("role", "Role", interface.get("mating_role"))
        field("pins", "Contact features", count("contacts"))
        field("variants", "Variants")
        field("ports", "Device ports")
    elif kind == "pinout":
        field("variant", "Variant", interface.get("variant_label"))
        field("role", "Role", interface.get("role"))
        field("pins", "Assignments", count("assignments"))
    elif kind == "port":
        field("device", "Device", interface.get("device_label"))
        field("role", "Role", interface.get("role"))
        field("pins", "Pin facts", count("pins"))
    elif kind == "board":
        field("origin", "Origin", interface.get("origin"))
        field("terminals", "Terminals", count("terminals"))
        field("connectors", "Carried connectors", count("carried_connectors"))
        field("paths", "Declared paths", count("paths"))
    elif kind == "wire_stock":
        stock = content.get("stock") or {}
        field("construction", "Construction", stock.get("construction"))
        structure = stock.get("structure")

        def conductors(node, depth=0):
            if not isinstance(node, dict) or depth > 12:
                return 0
            return int(node.get("kind") == "conductor") + sum(
                conductors(child, depth + 1) for child in node.get("children", [])
            )

        field("cores", "Cores", conductors(structure) if structure else None)
        facts = stock.get("facts") or {}
        # A declared root jacket is distinct from a computed packing envelope.
        jackets = [c for c in (structure or {}).get("children", []) if c.get("kind") == "jacket"]
        field(
            "outer_diameter",
            "Jacket OD",
            jackets[0].get("outer_diameter_mm") if len(jackets) == 1 else None,
            "mm",
        )
        fact = facts.get("impedance") or {}
        field(
            "impedance",
            "Impedance",
            fact.get("value") if fact.get("status") != "unknown" else None,
            fact.get("unit") or "ohm",
        )
    elif kind == "pcb_population":
        population = content.get("pcb_population") or {}
        for key, label in (
            ("options", "Population options"),
            ("associations", "Association declarations"),
        ):
            value = population.get(key)
            field(key, label, len(value) if isinstance(value, list) else None)
    elif kind == "part":
        part = content.get("part")
        part = part if isinstance(part, dict) and part.get("schema_version") == "1" else {}
        field("category", "Category", part.get("category"))
        field("value", "Value", part.get("value"))
        field("package", "Package", part.get("package"))
        field(
            "declared_fits", "Declared fit targets", len(part["fits"]) if "fits" in part else None
        )
    elif kind == "kit":
        kit = content.get("kit") or {}
        field(
            "part_lines",
            "Part lines",
            len(kit["lines"]) if isinstance(kit.get("lines"), list) else None,
        )
    elif kind == "mechanical_source":
        mechanical = content.get("mechanical_source") or {}
        field("role", "Role", mechanical.get("item_role"))
        field(
            "declared_targets",
            "Declared targets",
            len(mechanical["targets"]) if isinstance(mechanical.get("targets"), list) else None,
        )
    elif kind == "signal_set":
        field("signals", "Signals", count("signals"))
    elif kind == "end_assembly":
        field("stack", "Stack", "Declared" if interface.get("stack") else None)
    return values


def list_library_table(user, payload: ListLibraryTable) -> dict:
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    context = _context(workspace, payload.project_id)
    # Reuse reference semantics and cursor ordering, widening name search to exact MPN.
    base = ListLibrary(**{**payload.model_dump(exclude={"catalog_class"}), "query": ""})
    query, referenced, render, loader = _definitions(workspace, base, context)
    newest_draft = Draft.objects.filter(definition=OuterRef("pk")).order_by("-updated_at", "-id")
    query = query.annotate(selected_draft_id=Subquery(newest_draft.values("id")[:1]))
    if payload.catalog_class == "kits":
        query = query.filter(kind="kit")
    elif payload.catalog_class == "parts":
        query = query.filter(kind__in=["part", "material", "hardware", "mechanical_source"])
    elif payload.catalog_class == "hardware":
        # Match the same exact saved state used by the row: latest frozen, otherwise draft.
        latest = Revision.objects.filter(definition=OuterRef("pk")).order_by("-number")
        query = query.annotate(
            catalog_frozen=Cast(
                Func(
                    Subquery(latest.values("snapshot__canonical")[:1]),
                    Value("UTF8"),
                    function="convert_from",
                    output_field=TextField(),
                ),
                JSONField(),
            ),
            catalog_draft=Subquery(newest_draft.values("content")[:1]),
        )
        mechanical_roles = ["enclosure", "hardware"]
        part_categories = [
            "shell",
            "hardware",
            "enclosure",
            "fastener",
            "boot",
            "contact",
            "seal",
            "plug",
            "tool",
        ]
        query = query.filter(
            Q(kind="hardware")
            | Q(
                latest_revision_id__isnull=False,
                kind="part",
                catalog_frozen__content__part__schema_version="1",
                catalog_frozen__content__part__category__in=part_categories,
            )
            | Q(
                latest_revision_id__isnull=True,
                kind="part",
                catalog_draft__part__schema_version="1",
                catalog_draft__part__category__in=part_categories,
            )
            | Q(
                latest_revision_id__isnull=False,
                kind="mechanical_source",
                catalog_frozen__content__mechanical_source__item_role__in=mechanical_roles,
            )
            | Q(
                latest_revision_id__isnull=True,
                kind="mechanical_source",
                catalog_draft__mechanical_source__item_role__in=mechanical_roles,
            )
        )
    if payload.query:
        variants = ManufacturerVariant.objects.filter(
            revision_id=OuterRef("latest_revision_id")
        ).filter(Q(part_number__icontains=payload.query) | Q(manufacturer__icontains=payload.query))
        query = query.annotate(number_matches=Exists(variants)).filter(
            Q(name__icontains=payload.query) | Q(number_matches=True)
        )
    if context is not None:
        query = query.annotate(referenced=_referenced_flag(referenced))
        if payload.referenced_only:
            query = query.filter(referenced=True)
        query = query.order_by("-referenced", "-created_at", "-id")
    else:
        query = query.order_by("-created_at", "-id")
    rows = list(_page_after(query, payload.after, context is not None)[: payload.limit + 1])
    page = rows[: payload.limit]
    # The exact ids from the page govern every later load, including the base record.
    revisions = Revision.objects.filter(
        id__in=[r.latest_revision_id for r in page if r.latest_revision_id]
    ).select_related("definition", "snapshot__definition")
    frozen = {r.id: r for r in revisions}
    drafts = {
        d.id: d
        for d in Draft.objects.filter(
            id__in=[r.selected_draft_id for r in page if not r.latest_revision_id]
        ).select_related("definition")
    }
    numbers = defaultdict(list)
    for number in (
        ManufacturerVariant.objects.filter(revision_id__in=frozen)
        .annotate(
            position=Window(
                RowNumber(),
                partition_by=[F("revision_id")],
                order_by=["manufacturer", "part_number", "id"],
            )
        )
        .filter(position__lte=21)
        .order_by("manufacturer", "part_number", "id")
    ):
        numbers[number.revision_id].append(
            LibraryNumber(manufacturer=number.manufacturer, value=number.part_number)
        )
    protected_kinds = {"part", "kit", "material", "hardware", "mechanical_source"}
    protected = [
        revision for revision in frozen.values() if revision.definition.kind in protected_kinds
    ]
    allowed_drafts = set()
    with closure_reads():
        allowed_frozen = readable_revisions(actor, protected)
        prefetch_origins(draft.definition_id for draft in drafts.values())
        for draft in drafts.values():
            if draft.definition.kind not in protected_kinds:
                allowed_drafts.add(draft.id)
                continue
            try:
                authorize_design_content(actor, draft.definition, draft.content)
                allowed_drafts.add(draft.id)
            except OperationError:
                pass
    records = _records(page, render, loader, context)
    results = []
    for row, record in zip(page, records, strict=True):
        revision = frozen.get(row.latest_revision_id)
        draft = drafts.get(row.selected_draft_id) if not revision else None
        content = (
            json.loads(bytes(revision.snapshot.canonical))["content"]
            if revision
            else draft.content
            if draft
            else {}
        )
        unavailable = row.kind in protected_kinds and (
            (revision is not None and revision.id not in allowed_frozen)
            or (draft is not None and draft.id not in allowed_drafts)
        )
        if unavailable:
            revision, draft, content = None, None, {}
        basis = "latest_frozen" if revision else "newest_draft" if draft else "unknown"
        summary = LibrarySummary(
            basis=basis,
            revision_id=revision.id if revision else None,
            draft_id=draft.id if draft else None,
            draft_version=draft.version if draft else None,
            numbers=[] if unavailable else numbers[row.latest_revision_id][:20],
            numbers_truncated=not unavailable and len(numbers[row.latest_revision_id]) > 20,
            fields=_fields(row.kind, content),
            flags=["Current content unavailable"]
            if unavailable
            else ["No saved content"]
            if not content
            else [],
        )
        results.append(LibraryTableRecord(**record.model_dump(), summary=summary))
    next_after = None
    if len(rows) > payload.limit and page:
        last = page[-1]
        stamp = [last.created_at.isoformat(), str(last.id)]
        next_after = _encode(["1" if last.referenced else "0", *stamp] if context else stamp)
    return LibraryTablePage(
        workspace_id=workspace.id,
        family="definition",
        project_id=context.id if context else None,
        results=results,
        next_after=next_after,
    ).model_dump(mode="json")
