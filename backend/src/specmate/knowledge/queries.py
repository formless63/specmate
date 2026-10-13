"""Current-authority reads. Hidden link targets are omitted, never named or counted."""

import hashlib

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.design.operations import canonical_bytes
from specmate.facts.contracts import (
    DefinitionTarget,
    OccurrenceTarget,
    PhysicalUnitTarget,
    ProjectTarget,
    RevisionTarget,
)
from specmate.facts.queries import resolve_target
from specmate.knowledge.models import KnowledgeAttachment, KnowledgeItem, KnowledgeLink
from specmate.operations import NotFound, OperationError, ValidationFailed
from specmate.sources.authority import authorize_revision

MAX_ENTRIES = 500
MAX_LINKS = 500
MAX_TARGET_LINKS = 5000


def fingerprint(target) -> str:
    return hashlib.sha256(canonical_bytes(target.model_dump(mode="json"))).hexdigest()


def link_target(link):
    if link.kind == "project":
        return ProjectTarget(kind="project", project_id=link.target_project_id)
    if link.kind == "definition":
        return DefinitionTarget(
            kind="definition", definition_id=link.definition_id, feature_id=link.feature_id
        )
    if link.kind == "revision":
        return RevisionTarget(
            kind="revision", revision_id=link.revision_id, feature_id=link.feature_id
        )
    if link.kind == "physical_unit":
        return PhysicalUnitTarget(kind="physical_unit", unit_id=link.physical_unit_id)
    return OccurrenceTarget(
        kind="occurrence", snapshot_id=link.snapshot_id, path=link.path, feature_id=link.feature_id
    )


def describe_target(user, target):
    """Resolve and label a target under current read authority; raises when hidden."""
    from specmate.assemblies.queries import resolve_occurrence

    fields = resolve_target(user, target)
    result = {"target": target.model_dump(mode="json"), "project_id": str(fields["project"].id)}
    if target.kind == "project":
        result["label"] = fields["project"].name
    elif target.kind == "definition":
        definition = fields["definition"]
        result.update(label=definition.name, definition_kind=definition.kind)
    elif target.kind == "revision":
        revision = fields["revision"]
        result.update(
            label=f"{revision.definition.name} revision {revision.number}",
            definition_kind=revision.definition.kind,
            revision_number=revision.number,
            snapshot_sha256=revision.snapshot.sha256,
        )
    elif target.kind == "physical_unit":
        unit = fields["physical_unit"]
        result.update(
            label=f"Unit {unit.serial}",
            serial=unit.serial,
            revision_id=str(unit.revision_id),
            revision_number=unit.revision.number,
            definition_name=unit.revision.definition.name,
        )
    else:
        occurrence = resolve_occurrence(user, target.snapshot_id, target.path, target.feature_id)
        snapshot = fields["snapshot"]
        result.update(
            label=f"{snapshot.definition.name} / {'/'.join(target.path)}",
            root_assembly=snapshot.definition.name,
            occurrence_name=occurrence["name"],
            occurrence_revision_id=occurrence["revision_id"],
        )
    if getattr(target, "feature_id", None):
        result["feature_status"] = "not_evaluated"
    return result


def visible_link(user, link):
    try:
        description = describe_target(user, link_target(link))
    except OperationError:
        # Unreadable or no longer resolvable targets are omitted, never described.
        return None
    result = {
        "link_id": str(link.id),
        "item_id": str(link.item_id),
        **description,
        "linked_by": str(link.linked_by_id),
        "linked_at": link.created_at.isoformat(),
        "status": "active" if link.removed_at is None else "removed",
    }
    if link.removed_at is not None:
        result.update(
            removed_by=str(link.removed_by_id),
            removed_at=link.removed_at.isoformat(),
            removal_reason=link.removal_reason,
        )
    return result


def attachment_result(attachment):
    file = attachment.source_file
    return {
        "bundle_revision_id": str(file.revision_id),
        "bundle_id": str(file.revision.bundle_id),
        "bundle_name": file.revision.bundle.name,
        "revision_number": file.revision.number,
        "path": file.path,
        "sha256": file.blob.sha256,
        "size": file.blob.size,
        "media_type": file.media_type,
        "rights": file.rights,
        "label": attachment.label,
        "blob_project_id": str(file.blob.project_id),
    }


def get_item(user, item_id, permission=Perm.PROJECT_READ, *, lock=False):
    query = KnowledgeItem.objects
    if lock:
        query = query.select_for_update()
    item = query.filter(id=item_id).first()
    if item is None:
        raise NotFound("Knowledge item not found.")
    authorize(user, item.project_id, permission)
    entries = list(item.entries.order_by("number")[: MAX_ENTRIES + 1])
    if len(entries) > MAX_ENTRIES:
        raise ValidationFailed("Knowledge history exceeds the supported limit.")
    attachments = list(
        KnowledgeAttachment.objects.select_related(
            "source_file__revision__bundle", "source_file__blob"
        )
        .filter(entry__item=item)
        .order_by("entry__number", "id")
    )
    # Every referenced source, including historical entries, keeps current closure authority.
    for revision in {a.source_file.revision for a in attachments}:
        try:
            authorize_revision(user, revision)
        except OperationError:
            raise NotFound("Knowledge item not found.") from None
    by_entry = {}
    for attachment in attachments:
        by_entry.setdefault(attachment.entry_id, []).append(attachment)
    return item, entries, by_entry


def entry_result(entry, attachments):
    return {
        "entry_id": str(entry.id),
        "number": entry.number,
        "title": entry.title,
        "body": entry.body,
        "decision_status": entry.decision_status,
        "author": str(entry.author_id),
        "created_at": entry.created_at.isoformat(),
        "attachments": [attachment_result(a) for a in attachments],
    }


def item_summary(item, entries, by_entry):
    current = entries[-1]
    return {
        "item_id": str(item.id),
        "project_id": str(item.project_id),
        "kind": item.kind,
        "state": item.state_token,
        "current": entry_result(current, by_entry.get(current.id, [])),
    }


def read_item(user, item_id):
    user = current_actor(user)
    item, entries, by_entry = get_item(user, item_id)
    links = list(item.links.order_by("created_at", "id")[: MAX_LINKS + 1])
    if len(links) > MAX_LINKS:
        raise ValidationFailed("Knowledge links exceed the supported limit.")
    visible = [result for link in links if (result := visible_link(user, link)) is not None]
    return {
        **item_summary(item, entries, by_entry),
        "history": [entry_result(e, by_entry.get(e.id, [])) for e in entries],
        "links": [link for link in visible if link["status"] == "active"],
        "removed_links": [link for link in visible if link["status"] == "removed"],
        "relation_to_design_state": "attached_knowledge",
    }


def readable_item(user, item_id):
    try:
        return get_item(user, item_id)
    except OperationError:
        return None


def items_for_target(user, target, offset=0, limit=50):
    description = describe_target(user, target)
    links = list(
        KnowledgeLink.objects.filter(
            fingerprint=fingerprint(target), removed_at__isnull=True
        ).order_by("created_at", "id")[: MAX_TARGET_LINKS + 1]
    )
    if len(links) > MAX_TARGET_LINKS:
        raise ValidationFailed("Target links exceed the supported limit.")
    rows = []
    for link in links:
        readable = readable_item(user, link.item_id)
        if readable is None:
            continue
        rows.append({"link_id": str(link.id), **item_summary(*readable)})
    page = rows[offset : offset + limit]
    return {
        "target": description,
        "items": page,
        "offset": offset,
        "limit": limit,
        "has_more": len(rows) > offset + limit,
    }


def project_items(user, project_id, offset=0, limit=50):
    user = current_actor(user)
    project = authorize(user, project_id, Perm.PROJECT_READ)
    items = KnowledgeItem.objects.filter(project=project).order_by("created_at", "id")
    page = list(items[offset : offset + limit + 1])
    rows = [
        item_summary(*readable)
        for item in page[:limit]
        if (readable := readable_item(user, item.id)) is not None
    ]
    return {"items": rows, "offset": offset, "limit": limit, "has_more": len(page) > limit}
