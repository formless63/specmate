"""Scoped read queries shared by API and other adapters. Records outside the actor's
projects are indistinguishable from missing records."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from specmate.access.models import Membership
from specmate.access.permissions import Perm, authorize, permissions_for
from specmate.design.models import Definition, Draft, Revision
from specmate.design.operations import draft_state
from specmate.operations import NotFound
from specmate.sources.models import SourceBundleRevision


def list_projects(user: Any) -> list[dict]:
    if user is None or not user.is_authenticated:
        return []
    return [
        {
            "project_id": str(m.project_id),
            "name": m.project.name,
            "permissions": sorted(p.value for p in permissions_for(m)),
        }
        for m in Membership.objects.select_related("project")
        .filter(user=user)
        .order_by("project__created_at")
    ]


def list_definitions(user: Any, project_id: UUID) -> list[dict]:
    authorize(user, project_id, Perm.PROJECT_READ)
    return [
        {"definition_id": str(d.id), "kind": d.kind, "name": d.name}
        for d in Definition.objects.filter(project_id=project_id).order_by("created_at")
    ]


def get_draft(user: Any, draft_id: UUID) -> dict:
    draft = Draft.objects.select_related("definition").filter(id=draft_id).first()
    if draft is None:
        raise NotFound("Draft not found.")
    authorize(user, draft.definition.project_id, Perm.PROJECT_READ)
    return {"definition_id": str(draft.definition_id), **draft_state(draft)}


def get_revision(user: Any, revision_id: UUID) -> Revision:
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("Revision not found.")
    authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
    return revision


def get_bundle_revision(user: Any, revision_id: UUID) -> SourceBundleRevision:
    revision = SourceBundleRevision.objects.select_related("bundle").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Bundle revision not found.")
    authorize(user, revision.bundle.project_id, Perm.PROJECT_READ)
    return revision
