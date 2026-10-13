from django.utils import timezone

from specmate.access.permissions import Perm, authorize
from specmate.facts.queries import resolve_target, source_file
from specmate.knowledge.contracts import (
    CreateItem,
    ItemsForTarget,
    LinkItem,
    ProjectItems,
    ReadItem,
    ReviseItem,
    UnlinkItem,
)
from specmate.knowledge.models import (
    KnowledgeAttachment,
    KnowledgeEntry,
    KnowledgeItem,
    KnowledgeLink,
)
from specmate.knowledge.queries import (
    MAX_ENTRIES,
    MAX_LINKS,
    fingerprint,
    get_item,
    items_for_target,
    link_target,
    project_items,
    read_item,
    visible_link,
)
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)
from specmate.operations.scope import project_scope


def _attachments(ctx, project_id, refs):
    files = []
    for ref in refs:
        file = source_file(ctx.user, ref)
        if file.revision.bundle.project_id != project_id:
            raise ValidationFailed("Attachments reference files registered in the item's project.")
        files.append((file, ref.label))
    return files


def _write_entry(ctx, item, number, content):
    files = _attachments(ctx, item.project_id, content.attachments)
    entry = KnowledgeEntry.objects.create(
        item=item,
        number=number,
        title=content.title,
        body=content.body,
        decision_status=content.decision_status,
        author=ctx.user,
        request_id=ctx.request_id,
    )
    KnowledgeAttachment.objects.bulk_create(
        KnowledgeAttachment(entry=entry, source_file=file, label=label) for file, label in files
    )
    return entry


def _link(ctx, item, target):
    fields = resolve_target(ctx.user, target)
    key = fingerprint(target)
    existing = item.links.filter(fingerprint=key, removed_at__isnull=True).first()
    if existing is not None:
        return existing, False
    if item.links.count() >= MAX_LINKS:
        raise ValidationFailed("Knowledge links exceed the supported limit.")
    link = KnowledgeLink.objects.create(
        item=item,
        target_project=fields["project"],
        kind=fields["kind"],
        definition=fields.get("definition"),
        revision=fields.get("revision"),
        snapshot=fields.get("snapshot"),
        physical_unit=fields.get("physical_unit"),
        path=fields.get("path", []),
        feature_id=fields.get("feature_id"),
        fingerprint=key,
        linked_by=ctx.user,
        request_id=ctx.request_id,
    )
    return link, True


def _item_project(ctx, item_id):
    item = KnowledgeItem.objects.filter(id=item_id).first()
    if item is None:
        raise NotFound("Knowledge item not found.")
    return project_scope(ctx, item.project_id, Perm.DESIGN_EDIT)


def _authorize_stored_item(ctx, stored):
    get_item(ctx.user, stored["item_id"], Perm.DESIGN_EDIT)


def _create_scope(ctx, p):
    return project_scope(ctx, p.project_id, Perm.DESIGN_EDIT)


def _create_replay(ctx, p, stored):
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    _attachments(ctx, p.project_id, p.content.attachments)
    for target in p.links:
        resolve_target(ctx.user, target)
    _authorize_stored_item(ctx, stored)


@operation(
    "knowledge.create",
    CreateItem,
    summary="Create one note, decision or attachment reference and link it to exact objects.",
    idempotency_scope=_create_scope,
    authorize_replay=_create_replay,
)
def create_item(ctx: Context, p: CreateItem):
    project = authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    item = KnowledgeItem.objects.create(project=project, kind=p.kind, created_by=ctx.user)
    _write_entry(ctx, item, 1, p.content)
    for target in p.links:
        _link(ctx, item, target)
    return read_item(ctx.user, item.id)


def _revise_scope(ctx, p):
    return _item_project(ctx, p.item_id)


def _revise_replay(ctx, p, stored):
    get_item(ctx.user, p.item_id, Perm.DESIGN_EDIT)
    _authorize_stored_item(ctx, stored)


@operation(
    "knowledge.revise",
    ReviseItem,
    summary="Append a new content entry; earlier entries and attachments stay retrievable.",
    requires_expected_state=True,
    idempotency_scope=_revise_scope,
    authorize_replay=_revise_replay,
)
def revise_item(ctx: Context, p: ReviseItem):
    item, entries, _ = get_item(ctx.user, p.item_id, Perm.DESIGN_EDIT, lock=True)
    if ctx.require_expected_state() != item.state_token:
        raise Conflict(
            "Knowledge item changed. Nothing was overwritten; review the current entry.",
            details={"current_state": item.state_token, "current_number": entries[-1].number},
        )
    try:
        p.content.check_kind(item.kind)
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from None
    if len(entries) >= MAX_ENTRIES:
        raise ValidationFailed("Knowledge history exceeds the supported limit.")
    _write_entry(ctx, item, item.version + 1, p.content)
    item.version += 1
    item.save(update_fields=["version"])
    return read_item(ctx.user, item.id)


def _link_scope(ctx, p):
    return _item_project(ctx, p.item_id)


def _link_replay(ctx, p, stored):
    get_item(ctx.user, p.item_id, Perm.DESIGN_EDIT)
    resolve_target(ctx.user, p.target)
    link = KnowledgeLink.objects.filter(id=stored["link_id"], item_id=p.item_id).first()
    if link is None:
        raise NotFound("Knowledge link not found.")


@operation(
    "knowledge.link",
    LinkItem,
    summary="Reference an existing knowledge item from another exact engineering object.",
    idempotency_scope=_link_scope,
    authorize_replay=_link_replay,
)
def link_item(ctx: Context, p: LinkItem):
    item, _, _ = get_item(ctx.user, p.item_id, Perm.DESIGN_EDIT, lock=True)
    link, created = _link(ctx, item, p.target)
    return {**visible_link(ctx.user, link), "created": created, "state": item.state_token}


def _scoped_link(ctx, link_id, *, lock=False):
    query = KnowledgeLink.objects.select_related("item")
    if lock:
        query = query.select_for_update(of=("self",))
    link = query.filter(id=link_id).first()
    if link is None:
        raise NotFound("Knowledge link not found.")
    get_item(ctx.user, link.item_id, Perm.DESIGN_EDIT)
    try:
        resolve_target(ctx.user, link_target(link))
    except (NotFound, PermissionDenied):
        raise NotFound("Knowledge link not found.") from None
    return link


def _unlink_scope(ctx, p):
    return project_scope(ctx, _scoped_link(ctx, p.link_id).item.project_id, Perm.DESIGN_EDIT)


def _unlink_replay(ctx, p, stored):
    _scoped_link(ctx, p.link_id)


@operation(
    "knowledge.unlink",
    UnlinkItem,
    summary="Remove one link; the item, its attachments and other links are retained.",
    idempotency_scope=_unlink_scope,
    authorize_replay=_unlink_replay,
)
def unlink_item(ctx: Context, p: UnlinkItem):
    link = _scoped_link(ctx, p.link_id, lock=True)
    if link.removed_at is not None:
        raise Conflict(
            "Link was already removed.",
            details={"removed_at": link.removed_at.isoformat()},
        )
    link.removed_by = ctx.user
    link.removed_at = timezone.now()
    link.removal_request_id = ctx.request_id
    link.removal_reason = p.reason
    link.save(update_fields=["removed_by", "removed_at", "removal_request_id", "removal_reason"])
    return visible_link(ctx.user, link)


@operation(
    "knowledge.read",
    ReadItem,
    summary="Inspect one item, its entry history and the links visible to the actor.",
    supports_idempotency=False,
)
def inspect_item(ctx: Context, p: ReadItem):
    return read_item(ctx.user, p.item_id)


@operation(
    "knowledge.for_target",
    ItemsForTarget,
    summary="List readable knowledge items linked to one exact engineering object.",
    supports_idempotency=False,
)
def target_items(ctx: Context, p: ItemsForTarget):
    return items_for_target(ctx.user, p.target, p.offset, p.limit)


@operation(
    "knowledge.list",
    ProjectItems,
    summary="List knowledge items owned by a project.",
    supports_idempotency=False,
)
def list_items(ctx: Context, p: ProjectItems):
    return project_items(ctx.user, p.project_id, p.offset, p.limit)
