"""Batched reads for one synchronous closure authorization.

Every workspace member reads every record in the workspace, and database guards keep
each frozen pin inside one workspace. Authorizing a closure therefore needs one
membership read per workspace, not one per node, and its node rows can be loaded per
level instead of per node. ``closure_reads`` scopes that reuse to one read-only
traversal: nothing is retained between operations, requests or actors' calls, and every
per-node check (typed content, retained catalog origins) still runs. Origin authority is
resolved on every check; only positive immutable file rows are reused for that actor,
revision and path, and their hash/rights are checked again.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from specmate.access.permissions import memoized_membership

# Definitions known, inside the active block, to have no retained catalog adoption.
_without_origin: ContextVar[set | None] = ContextVar("closure_without_origin", default=None)


# Exact revisions whose complete closure this traversal already authorized, by actor.
_authorized_revisions: ContextVar[dict | None] = ContextVar(
    "closure_authorized_revisions", default=None
)

# Immutable source files that have already been loaded during this traversal. Keep the
# actor in the key so this diagnostic-row reuse never crosses actors within a context.
_source_files: ContextVar[dict | None] = ContextVar("closure_source_files", default=None)


@contextmanager
def closure_reads() -> Iterator[None]:
    """Reuse membership and origin-presence reads inside one read-only traversal."""
    if _without_origin.get() is not None:
        yield
        return
    token = _without_origin.set(set())
    revisions = _authorized_revisions.set({})
    source_files = _source_files.set({})
    try:
        with memoized_membership():
            yield
    finally:
        _source_files.reset(source_files)
        _authorized_revisions.reset(revisions)
        _without_origin.reset(token)


def source_bundle_file(user: Any, revision_id: Any, path: str) -> Any:
    """Load an exact immutable source file, reusing only positive scoped reads."""
    known = _source_files.get()
    key = (getattr(user, "pk", None), str(revision_id), path)
    if known is not None and key in known:
        return known[key]

    from specmate.sources.models import SourceBundleFile

    file = (
        SourceBundleFile.objects.select_related("blob")
        .filter(revision_id=revision_id, path=path)
        .first()
    )
    if file is not None and known is not None:
        known[key] = file
    return file


def authorized_revision(user: Any, revision_id: Any) -> Any:
    """The revision this traversal already fully authorized for this actor, else None."""
    known = _authorized_revisions.get()
    if known is None:
        return None
    return known.get((getattr(user, "pk", None), str(revision_id)))


def remember_authorized_revision(user: Any, revision: Any) -> None:
    known = _authorized_revisions.get()
    if known is not None:
        known[(getattr(user, "pk", None), str(revision.id))] = revision


def prefetch_origins(definition_ids: Iterable[Any]) -> None:
    """One query: remember which of these definitions carry no catalog adoption."""
    known = _without_origin.get()
    if known is None:
        return
    wanted = {str(d) for d in definition_ids} - known
    if not wanted:
        return
    from specmate.catalog_packs.models import AdoptionEntry

    adopted = {
        str(d)
        for d in AdoptionEntry.objects.filter(definition_id__in=wanted).values_list(
            "definition_id", flat=True
        )
    }
    known.update(wanted - adopted)


def without_origin(definition_id: Any) -> bool:
    known = _without_origin.get()
    return known is not None and str(definition_id) in known
