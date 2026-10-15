"""One typed pin policy for generic draft operations, snapshots and catalog reads."""

from pydantic import ValidationError

from specmate.design.closure_reads import (
    authorized_revision,
    closure_reads,
    prefetch_origins,
    remember_authorized_revision,
)
from specmate.design.models import Revision
from specmate.design.pins import check_pin
from specmate.operations import NotFound, OperationError, ValidationFailed
from specmate.parts.contracts import Kit, Part

# A kit line groups an exact reusable physical design, never another kit or a vocabulary.
ITEM_KINDS = frozenset(
    {
        "part",
        "material",
        "hardware",
        "connector_body",
        "wire_stock",
        "board",
        "pcb_population",
        "mechanical_source",
        "assembly",
        "end_assembly",
    }
)


def typed(kind, content):
    if kind == "kit" or "kit" in content:
        if kind != "kit" or "kit" not in content:
            raise ValidationFailed("A kit requires its typed catalog grouping.")
        model, key = Kit, "kit"
    else:
        value = content.get("part")
        if not isinstance(value, dict) or "schema_version" not in value:
            return None
        if kind != "part":
            raise ValidationFailed("A typed part description requires a part definition.")
        model, key = Part, "part"
    try:
        return key, model.model_validate(content[key])
    except ValidationError as error:
        raise ValidationFailed(
            "Invalid typed catalog content.",
            details={
                "errors": [
                    {"path": list(row["loc"]), "message": row["msg"]}
                    for row in error.errors(include_input=False)
                ]
            },
        ) from None


def validate_content(kind, content):
    selected = typed(kind, content)
    return {**content, selected[0]: selected[1].model_dump(mode="json")} if selected else content


def dependency_revisions(user, definition, content):
    selected = typed(definition.kind, content)
    if selected is None:
        return None
    key, value = selected
    ids = {row.revision_id for row in (value.lines if key == "kit" else value.fits)}
    if not ids:
        return []
    from specmate.design.operations import authorize_snapshots

    with closure_reads():
        known = {rid: authorized_revision(user, rid) for rid in ids}
        missing = [rid for rid, revision in known.items() if revision is None]
        rows = list(
            Revision.objects.filter(id__in=missing).select_related(
                "definition", "snapshot__definition"
            )
        )
        found = {
            **{rid: revision for rid, revision in known.items() if revision},
            **{row.id: row for row in rows},
        }
        if set(found) != ids:
            raise NotFound("Not found.")
        for revision in found.values():
            check_pin(user, revision, definition.workspace_id)
        prefetch_origins(row.definition_id for row in rows)
        authorize_snapshots(user, [row.snapshot for row in rows])
        # Current source/snapshot authority precedes kind and self-reference diagnostics.
        if any(row.definition.kind == "kit" for row in found.values()):
            raise ValidationFailed("Nested kit groupings are not supported.")
        if any(row.definition.kind not in ITEM_KINDS for row in found.values()):
            raise ValidationFailed("Select an exact physical catalog design revision.")
        if any(row.definition_id == definition.pk for row in found.values()):
            raise ValidationFailed("A part or kit cannot refer to its own definition.")
        for revision in rows:
            remember_authorized_revision(user, revision)
        return sorted(ids, key=str)


def readable_revisions(user, rows):
    """Batch ordinary reads, isolating denied closures without publishing their labels."""
    if not rows:
        return set()
    from specmate.design.operations import authorize_snapshots

    try:
        authorize_snapshots(user, [row.snapshot for row in rows])
        return {row.id for row in rows}
    except OperationError:
        if len(rows) == 1:
            return set()
        middle = len(rows) // 2
        return readable_revisions(user, rows[:middle]) | readable_revisions(user, rows[middle:])
