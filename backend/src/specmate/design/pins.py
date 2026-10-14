"""Exact pins stay inside one workspace: typed closures reject foreign revisions early.

Database guards keep every frozen pin inside its workspace, so a frozen closure needs no
per-dependency membership lookup. Draft content is not guarded by the database, and an
actor who belongs to two workspaces could otherwise name a revision from the other one;
the snapshot or record insert would then fail on a guard. Typed closures call
``check_pin`` for every revision named in content, which rejects a revision outside the
closure's workspace with the same ``NotFound`` a non-member receives, before any guard,
diagnostic or write.

The expected workspace is explicit (``workspace_id``), or set for a synchronous traversal
by ``pin_workspace`` at the entry point that knows the owning definition or root. Without
either, the first checked revision fixes it for the caller's closure.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from specmate.access.permissions import Perm, authorize
from specmate.operations import NotFound

NOT_FOUND = "Not found."
_SCOPE: ContextVar[str | None] = ContextVar("design_pin_workspace", default=None)


def _key(value: Any) -> str | None:
    if value is None:
        return None
    return str(getattr(value, "id", value))


@contextmanager
def pin_workspace(workspace_id: Any):
    """Require every pin checked inside this block to belong to ``workspace_id``."""
    key = _key(workspace_id)
    current = _SCOPE.get()
    if current is not None and key is not None and current != key:
        # A nested root from another workspace can never be pinned here.
        raise NotFound(NOT_FOUND)
    token = _SCOPE.set(current or key)
    try:
        yield
    finally:
        _SCOPE.reset(token)


def expected_workspace(workspace_id: Any = None) -> str | None:
    return _key(workspace_id) or _SCOPE.get()


def check_pin(user: Any, revision: Any, workspace_id: Any = None):
    """Authorize one pinned revision; return its workspace id for the closure to keep.

    A missing revision, a foreign workspace and a non-member all read as ``Not found.``.
    """
    if revision is None:
        raise NotFound(NOT_FOUND)
    actual = revision.definition.workspace_id
    expected = expected_workspace(workspace_id)
    if expected is not None and expected != str(actual):
        raise NotFound(NOT_FOUND)
    authorize(user, actual, Perm.WORKSPACE_READ)
    return actual


def item_workspace(user: Any, workspace_id: Any = None):
    """The workspace collection a typed create adds its item to (item.create).

    An omitted workspace means the actor's only membership. Creating an item never takes
    a project: projects reference collection items afterwards.
    """
    from specmate.access.workspaces import actor_workspace_id

    return authorize(user, actor_workspace_id(user, workspace_id), Perm.ITEM_CREATE)
