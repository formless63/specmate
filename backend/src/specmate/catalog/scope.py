"""Library scope: the workspace collection, optionally viewed from one project.

A project is navigation context only (docs/DOMAIN.md "Workspace, collections and
projects"). At project scope a library list shows the items the project references first
and marks them; it never hides other workspace items and never changes authority.
"""

from __future__ import annotations

from uuid import UUID

from django.db.models import Exists, OuterRef, Q

from specmate.access.models import ProjectReference
from specmate.access.permissions import Perm, authorize, authorize_project, member_workspaces
from specmate.access.workspaces import actor_workspace_id
from specmate.operations import NotFound


def library_scope(user, workspace_id: UUID | None = None, project_id: UUID | None = None):
    """Return ``(workspace, project)`` after a current workspace-read check.

    Non-members receive the same NotFound for a workspace or a project context. A
    project from another workspace than the one named is indistinguishable from a
    missing project.
    """
    if project_id is not None:
        project = authorize_project(user, project_id, Perm.WORKSPACE_READ)
        if workspace_id is not None and project.workspace_id != workspace_id:
            raise NotFound("Not found.")
        return project.workspace, project
    workspace = authorize(user, actor_workspace_id(user, workspace_id), Perm.WORKSPACE_READ)
    return workspace, None


def searchable_workspaces(user, workspace_id: UUID | None = None, project_id: UUID | None = None):
    """Workspaces a search covers and the optional project context.

    Without an explicit scope a search covers every workspace the actor is currently a
    member of (an actor without membership simply finds nothing).
    """
    if workspace_id is None and project_id is None:
        return member_workspaces(user), None
    workspace, project = library_scope(user, workspace_id, project_id)
    return member_workspaces(user).filter(id=workspace.id), project


def active_references(project):
    return ProjectReference.objects.filter(project=project, removed_at__isnull=True)


def references_definition(project, definition_path: str = "id"):
    """``Exists`` for a definition the project references floating or by exact revision."""
    return Exists(
        active_references(project).filter(
            Q(kind="definition", definition_id=OuterRef(definition_path))
            | Q(kind="revision", revision__definition_id=OuterRef(definition_path))
        )
    )


def references_revision(project, revision_path: str, definition_path: str):
    """``Exists`` for an exact revision reference or a floating reference to its definition."""
    return Exists(
        active_references(project).filter(
            Q(kind="revision", revision_id=OuterRef(revision_path))
            | Q(kind="definition", definition_id=OuterRef(definition_path))
        )
    )


def references_bundle(project, bundle_path: str = "id"):
    return Exists(
        active_references(project).filter(
            kind="source_bundle", source_bundle_id=OuterRef(bundle_path)
        )
    )


def context_first(queryset, referenced, after, *, cursor_error: str):
    """Order by "referenced by the project context" then id, continuing from a cursor.

    ``referenced`` is an ``Exists`` expression or None (plain id order). The cursor must
    be a row of the same scoped query, otherwise NotFound is raised.
    """
    if referenced is None:
        ordered = queryset.order_by("id")
        if after is not None:
            if not queryset.filter(id=after).exists():
                raise NotFound(cursor_error)
            ordered = ordered.filter(id__gt=after)
        return ordered
    annotated = queryset.annotate(in_project=referenced)
    ordered = annotated.order_by("-in_project", "id")
    if after is not None:
        cursor = annotated.filter(id=after).values_list("in_project", flat=True).first()
        if cursor is None:
            raise NotFound(cursor_error)
        if cursor:
            ordered = ordered.filter(Q(in_project=True, id__gt=after) | Q(in_project=False))
        else:
            ordered = ordered.filter(in_project=False, id__gt=after)
    return ordered


def creation_workspace(user, workspace_id=None, project_id=None, permission=Perm.ITEM_CREATE):
    """The workspace a new collection item is added to, after a current permission check.

    TRANSITIONAL (workspace collections P1-P3): ``project_id`` only selects its workspace
    for callers that have not moved to ``workspace_id``; the item is never owned by the
    project and no reference is created. P3 removes it.
    """
    return authorize(user, actor_workspace_id(user, workspace_id or project_id), permission)
