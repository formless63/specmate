"""Provenance hooks for owning drafts and exact captured dependency closure."""

from contextvars import ContextVar

from specmate.catalog_packs.models import AdoptionEntry
from specmate.catalog_packs.queries import manifest_of, version_closure
from specmate.design.closure_reads import without_origin
from specmate.operations import ValidationFailed
from specmate.queries import get_revision

MAX_ORIGIN_DEPTH = 32
MAX_ORIGIN_RECORDS = 2000
_origin_path: ContextVar[tuple] = ContextVar("catalog_origin_path", default=())
_origin_records: ContextVar[set | None] = ContextVar("catalog_origin_records", default=None)


def origin_revisions(user, definition):
    records_token = None
    if _origin_records.get() is None:
        records_token = _origin_records.set(set())
    try:
        return _origin_revisions(user, definition)
    finally:
        if records_token is not None:
            _origin_records.reset(records_token)


def _origin_revisions(user, definition):
    if without_origin(definition.pk):
        # Prefetched for this closure traversal: no retained adoption to authorize.
        return []
    adoptions = list(
        AdoptionEntry.objects.select_related("entry__version__pack", "entry__revision").filter(
            definition=definition
        )
    )
    dependencies = set()
    for adoption in adoptions:
        path = _origin_path.get()
        records = _origin_records.get()
        if adoption.pk in path:
            raise ValidationFailed("Catalog adoption origin contains a cycle.")
        if len(path) >= MAX_ORIGIN_DEPTH:
            raise ValidationFailed("Catalog adoption origin exceeds the supported depth.")
        records.add(adoption.pk)
        if len(records) > MAX_ORIGIN_RECORDS:
            raise ValidationFailed("Catalog adoption origin exceeds the supported record bound.")
        token = _origin_path.set((*path, adoption.pk))
        try:
            entry = adoption.entry
            version_closure(user, [entry.version])
            source = get_revision(user, entry.revision_id)
            dependencies.add(source.id)
            dependencies.update(source.snapshot.dependencies.values_list("revision_id", flat=True))
            if not any(
                item.key == entry.key and item.revision_id == source.id
                for item in manifest_of(entry.version).entries
            ):
                raise ValidationFailed("Pack provenance entry is inconsistent.")
        finally:
            _origin_path.reset(token)
    return sorted(dependencies, key=str)


def authorize_origin(user, definition):
    origin_revisions(user, definition)
