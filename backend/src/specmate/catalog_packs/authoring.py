"""Provenance hooks for owning drafts and exact captured dependency closure."""

from specmate.catalog_packs.models import AdoptionEntry
from specmate.catalog_packs.queries import manifest_of, version_closure
from specmate.operations import ValidationFailed
from specmate.queries import get_revision


def origin_revisions(user, definition):
    adoptions = list(
        AdoptionEntry.objects.select_related("entry__version__pack", "entry__revision").filter(
            definition=definition
        )
    )
    dependencies = set()
    for adoption in adoptions:
        entry = adoption.entry
        version_closure(user, [entry.version])
        source = get_revision(user, entry.revision_id)
        dependencies.add(source.id)
        dependencies.update(source.snapshot.dependencies.values_list("revision_id", flat=True))
        # Verify the stored manifest still describes this exact entry identity.
        if not any(
            item.key == entry.key and item.revision_id == source.id
            for item in manifest_of(entry.version).entries
        ):
            raise ValidationFailed("Pack provenance entry is inconsistent.")
    return sorted(dependencies, key=str)


def authorize_origin(user, definition):
    origin_revisions(user, definition)
