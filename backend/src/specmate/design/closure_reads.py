"""Batched reads for one synchronous closure authorization.

Every workspace member reads every record in the workspace, and database guards keep
each frozen pin inside one workspace. Authorizing a closure therefore needs one
membership read per workspace, not one per node, and its node rows can be loaded per
level instead of per node. ``closure_reads`` scopes that reuse to one read-only
traversal: nothing is retained between operations, requests or actors' calls, and every
per-node check (typed content, retained catalog origins) still runs.
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


@contextmanager
def closure_reads() -> Iterator[None]:
    """Reuse membership and origin-presence reads inside one read-only traversal."""
    if _without_origin.get() is not None:
        yield
        return
    token = _without_origin.set(set())
    revisions = _authorized_revisions.set({})
    try:
        with memoized_membership():
            yield
    finally:
        _authorized_revisions.reset(revisions)
        _without_origin.reset(token)


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
