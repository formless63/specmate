"""Scoped read queries shared by API and other adapters. Records outside the actor's
workspace are indistinguishable from missing records."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from specmate.access.models import Project, WorkspaceMember
from specmate.access.permissions import Perm, authorize, permissions_for
from specmate.access.workspaces import actor_workspace_id
from specmate.design.models import Definition, Draft, Revision
from specmate.design.operations import authorize_design_content, authorize_snapshot, draft_state
from specmate.design.pins import check_pin
from specmate.operations import NotFound
from specmate.sources.models import SourceBundleRevision


def list_projects(user: Any, *, include_archived: bool = False) -> list[dict]:
    """Every project in the actor's workspaces, with the actor's workspace permissions."""
    if user is None or not user.is_authenticated:
        return []
    held = {
        m.workspace_id: sorted(p.value for p in permissions_for(m))
        for m in WorkspaceMember.objects.filter(user=user)
    }
    projects = Project.objects.filter(workspace_id__in=held).order_by("created_at", "id")
    if not include_archived:
        projects = projects.filter(archived_at__isnull=True)
    return [
        {
            "project_id": str(project.id),
            "workspace_id": str(project.workspace_id),
            "name": project.name,
            "purpose": project.purpose,
            "archived": project.archived_at is not None,
            "permissions": held[project.workspace_id],
        }
        for project in projects
    ]


def list_definitions(user: Any, workspace_id: UUID | None) -> list[dict]:
    """Every definition in a workspace collection (omitted: the actor's workspace)."""
    workspace = authorize(user, actor_workspace_id(user, workspace_id), Perm.WORKSPACE_READ)
    return [
        {"definition_id": str(d.id), "kind": d.kind, "name": d.name}
        for d in Definition.objects.filter(workspace=workspace).order_by("created_at")
    ]


def get_draft(user: Any, draft_id: UUID) -> dict:
    draft = Draft.objects.select_related("definition").filter(id=draft_id).first()
    if draft is None:
        raise NotFound("Draft not found.")
    authorize(user, draft.definition.workspace_id, Perm.WORKSPACE_READ)
    authorize_design_content(user, draft.definition, draft.content)
    return {"definition_id": str(draft.definition_id), **draft_state(draft)}


def get_revision(user: Any, revision_id: UUID) -> Revision:
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("Revision not found.")
    # Inside a typed closure a foreign-workspace pin reads as missing, before any guard.
    check_pin(user, revision)
    authorize_snapshot(user, revision.snapshot)
    return revision


def get_bundle_revision(user: Any, revision_id: UUID) -> SourceBundleRevision:
    from specmate.catalog_matching.queries import current_actor
    from specmate.sources.authority import authorize_revision

    user = current_actor(user)
    revision = SourceBundleRevision.objects.select_related("bundle").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Bundle revision not found.")
    authorize_revision(user, revision)
    return revision
