"""Live permitted text/metadata search; no hidden snippets, totals or cursor identities."""

from django.db.models import F, Q

from specmate.access.permissions import Perm, authorize, visible_projects
from specmate.catalog.discovery import visible_page
from specmate.catalog_matching.queries import current_actor
from specmate.knowledge.models import KnowledgeEntry
from specmate.knowledge.queries import (
    MAX_LINKS,
    attachment_result,
    describe_target,
    fingerprint,
    get_item,
    visible_link,
)
from specmate.knowledge.search_contracts import SearchKnowledge
from specmate.operations import Context, NotFound, ValidationFailed, operation

SNIPPET_LENGTH = 320


def snippet(text, query):
    """Plain Unicode text. Consumers render it as text, never as supplied markup."""
    position = text.lower().find(query.lower())
    start = max(0, position - 80)
    value = text[start : start + SNIPPET_LENGTH]
    return ("…" if start else "") + value + ("…" if start + len(value) < len(text) else "")


def _search_knowledge(user, payload):
    user = current_actor(user)
    if payload.project_id:
        authorize(user, payload.project_id, Perm.PROJECT_READ)
    target = describe_target(user, payload.target) if payload.target else None
    query = KnowledgeEntry.objects.select_related("item").filter(
        item__project__in=visible_projects(user)
    )
    if payload.project_id:
        query = query.filter(item__project_id=payload.project_id)
    if payload.kind:
        query = query.filter(item__kind=payload.kind)
    if not payload.include_history:
        query = query.filter(number=F("item__version"))
    if payload.target:
        query = query.filter(
            item__links__fingerprint=fingerprint(payload.target),
            item__links__removed_at__isnull=True,
        )
    text = payload.query
    metadata = [
        "label",
        "source_file__path",
        "source_file__rights",
        "source_file__media_type",
        "source_file__blob__sha256",
        "source_file__revision__bundle__name",
    ]
    match = Q(title__icontains=text) | Q(body__icontains=text)
    for field in metadata:
        match |= Q(**{f"attachments__{field}__icontains": text})
    query = query.filter(match).distinct()
    # Authorization reuse belongs only to this invocation, never a session or global cache.
    authorized = {}

    def render(entry):
        if entry.item_id not in authorized:
            authorized[entry.item_id] = get_item(user, entry.item_id)
        item, entries, by_entry = authorized[entry.item_id]
        attachments = [attachment_result(a) for a in by_entry.get(entry.id, [])]
        links = list(item.links.filter(removed_at__isnull=True).order_by("id")[: MAX_LINKS + 1])
        if len(links) > MAX_LINKS:
            raise ValidationFailed("Knowledge links exceed the supported limit.")
        visible = [value for link in links if (value := visible_link(user, link)) is not None]
        fields = {"title": entry.title, "body": entry.body}
        for index, attachment in enumerate(attachments):
            for field in ("label", "path", "rights", "media_type", "sha256", "bundle_name"):
                fields[f"attachment.{index}.{field}"] = attachment[field]
        matches = [
            {"field": name, "text": snippet(value, text)}
            for name, value in fields.items()
            if text.lower() in value.lower()
        ][:5]
        return {
            "record_id": str(entry.id),
            "item_id": str(item.id),
            "project_id": str(item.project_id),
            "kind": item.kind,
            "entry_id": str(entry.id),
            "entry_number": entry.number,
            "current": entry.number == entries[-1].number,
            "title": entry.title,
            "decision_status": entry.decision_status,
            "matches": matches,
            "attachments": attachments,
            "links": visible,
        }

    page = visible_page(query, payload, render)
    # Rendering can overlap a separately committed revocation. Do not emit a page
    # authorized only by the earlier per-invocation cache. A lost item fails this
    # request closed; foreign target links still follow the owned-note filter policy.
    user = current_actor(user)
    if payload.project_id:
        authorize(user, payload.project_id, Perm.PROJECT_READ)
    if payload.target:
        target = describe_target(user, payload.target)
    # Cursor and lookahead items also determine the disclosed page/cursor. Their
    # successfully consumed closures must still be readable, even if not returned.
    fresh_items = {str(item_id): get_item(user, item_id)[0] for item_id in authorized}
    refreshed = {}
    for row in page["results"]:
        if row["item_id"] not in refreshed:
            item = fresh_items[row["item_id"]]
            links = list(item.links.filter(removed_at__isnull=True).order_by("id")[: MAX_LINKS + 1])
            if len(links) > MAX_LINKS:
                raise ValidationFailed("Knowledge links exceed the supported limit.")
            refreshed[row["item_id"]] = [
                value for link in links if (value := visible_link(user, link)) is not None
            ]
        row["links"] = refreshed[row["item_id"]]
    return {
        "query": text,
        "target": target,
        "include_history": payload.include_history,
        **page,
    }


def search_knowledge(user, payload):
    """Forbidden and missing exact inputs share one denial without existence hints."""
    try:
        return _search_knowledge(user, payload)
    except NotFound:
        raise NotFound("Knowledge search inputs unavailable.") from None


@operation(
    "knowledge.search",
    SearchKnowledge,
    supports_idempotency=False,
    summary="Search permitted knowledge text and attachment metadata with exact entry provenance.",
)
def search(ctx: Context, payload: SearchKnowledge):
    return search_knowledge(ctx.user, payload)
