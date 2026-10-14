"""Projects: composition and decision contexts that reference workspace collection items.

A project owns nothing in a collection. It holds its name, purpose and an append-only
set of references; adding or removing one never creates, copies, moves or edits the
referenced item. Every member sees every project; the workspace role decides edits.
"""

from __future__ import annotations

import hashlib
import json
from typing import Literal
from uuid import UUID

from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from pydantic import BaseModel, ConfigDict, Field

from specmate.access.models import Project, ProjectReference
from specmate.access.permissions import Perm, authorize, authorize_project, held_permissions
from specmate.access.workspaces import actor_workspace_id
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation

ReferenceKind = Literal["definition", "revision", "source_bundle", "physical_unit", "work_batch"]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateProject(Payload):
    name: str = Field(min_length=1, max_length=200)
    purpose: str = Field(default="", max_length=2000)
    workspace_id: UUID | None = None


class ProjectRef(Payload):
    project_id: UUID


class ReadProject(ProjectRef):
    include_removed: bool = False


class RenameProject(ProjectRef):
    name: str = Field(min_length=1, max_length=200)
    purpose: str | None = Field(default=None, max_length=2000)


class ArchiveProject(ProjectRef):
    archived: bool = True


class AddReference(ProjectRef):
    kind: ReferenceKind
    target_id: UUID
    role: str = Field(min_length=1, max_length=100)
    note: str = Field(default="", max_length=2000)


class RemoveReference(ProjectRef):
    reference_id: UUID
    reason: str = Field(min_length=1, max_length=1000)


def state(project: Project) -> str:
    active = sorted(
        str(r)
        for r in ProjectReference.objects.filter(
            project=project, removed_at__isnull=True
        ).values_list("id", flat=True)
    )
    body = json.dumps(
        {
            "name": project.name,
            "purpose": project.purpose,
            "archived": project.archived_at is not None,
            "references": active,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return f"project:{project.id}:{hashlib.sha256(body.encode()).hexdigest()}"


def reference_view(reference: ProjectReference) -> dict:
    return {
        "reference_id": str(reference.id),
        "kind": reference.kind,
        "target_id": str(reference.target_id),
        "pin": "exact" if reference.kind == "revision" else "floating",
        "role": reference.role,
        "note": reference.note,
        "added_by": reference.added_by.get_username(),
        "added_at": reference.added_at.isoformat(),
        "removed": reference.removed_at is not None,
        "removed_at": reference.removed_at.isoformat() if reference.removed_at else None,
        "removal_reason": reference.removal_reason,
    }


def project_view(project: Project, *, include_removed: bool = False) -> dict:
    references = (
        ProjectReference.objects.select_related("added_by")
        .filter(project=project)
        .order_by("added_at", "id")
    )
    if not include_removed:
        references = references.filter(removed_at__isnull=True)
    return {
        "project_id": str(project.id),
        "workspace_id": str(project.workspace_id),
        "name": project.name,
        "purpose": project.purpose,
        "archived": project.archived_at is not None,
        "archived_at": project.archived_at.isoformat() if project.archived_at else None,
        "state": state(project),
        "references": [reference_view(r) for r in references],
    }


def check_state(ctx: Context, project: Project) -> None:
    current = state(project)
    if ctx.require_expected_state() != current:
        raise Conflict("Project changed since expected state.", details={"current_state": current})


def editable(ctx: Context, project_id: UUID) -> Project:
    project = authorize_project(ctx.user, project_id, Perm.PROJECT_EDIT, lock=True)
    check_state(ctx, project)
    return project


def require_active(project: Project) -> None:
    if project.archived_at is not None:
        raise Conflict("Archived projects are read-only; unarchive the project first.")


def edit_scope(ctx, p) -> str:
    project = authorize_project(ctx.user, p.project_id, Perm.PROJECT_EDIT)
    return f"workspace:{project.workspace_id}"


def edit_replay(ctx, p, stored) -> None:
    authorize_project(ctx.user, p.project_id, Perm.PROJECT_EDIT)


def create_scope(ctx, p) -> str:
    workspace = authorize(ctx.user, actor_workspace_id(ctx.user, p.workspace_id), Perm.PROJECT_EDIT)
    return f"workspace:{workspace.id}"


def create_replay(ctx, p, stored) -> None:
    authorize(ctx.user, stored["workspace_id"], Perm.PROJECT_EDIT)


@operation(
    "project.create",
    CreateProject,
    summary="Create a project in the actor's workspace; it references items, owns none.",
    idempotency_scope=create_scope,
    authorize_replay=create_replay,
)
def create_project(ctx: Context, p: CreateProject) -> dict:
    workspace = authorize(ctx.user, actor_workspace_id(ctx.user, p.workspace_id), Perm.PROJECT_EDIT)
    project = Project.objects.create(
        workspace=workspace, name=p.name, purpose=p.purpose, created_by=ctx.user
    )
    return project_view(project)


@operation(
    "project.references",
    ReadProject,
    summary="Read a project and its current (or full) reference history.",
    supports_idempotency=False,
)
def read_project(ctx: Context, p: ReadProject) -> dict:
    project = authorize_project(ctx.user, p.project_id, Perm.WORKSPACE_READ)
    return {
        **project_view(project, include_removed=p.include_removed),
        "permissions": sorted(x.value for x in held_permissions(ctx.user, project.workspace_id)),
    }


@operation(
    "project.rename",
    RenameProject,
    summary="Rename a project or change its purpose under its state token.",
    requires_expected_state=True,
    idempotency_scope=edit_scope,
    authorize_replay=edit_replay,
)
def rename_project(ctx: Context, p: RenameProject) -> dict:
    project = editable(ctx, p.project_id)
    require_active(project)
    project.name = p.name
    if p.purpose is not None:
        project.purpose = p.purpose
    project.save(update_fields=["name", "purpose"])
    return project_view(project)


@operation(
    "project.archive",
    ArchiveProject,
    summary="Archive or unarchive a project; referenced items and history are unchanged.",
    requires_expected_state=True,
    idempotency_scope=edit_scope,
    authorize_replay=edit_replay,
)
def archive_project(ctx: Context, p: ArchiveProject) -> dict:
    project = editable(ctx, p.project_id)
    if p.archived and project.archived_at is None:
        project.archived_at, project.archived_by = timezone.now(), ctx.user
    elif not p.archived and project.archived_at is not None:
        project.archived_at, project.archived_by = None, None
    project.save(update_fields=["archived_at", "archived_by"])
    return project_view(project)


def dependents(project: Project) -> dict[str, int]:
    """Records outside the project's own references that point at it (releases,
    decisions, notes, reviews, reservations, work, builds, links and future records)."""
    counts = {}
    for relation in Project._meta.get_fields(include_hidden=True):
        if not (relation.auto_created and not relation.concrete and relation.is_relation):
            continue
        if relation.related_model is ProjectReference:
            continue
        model = relation.related_model
        count = model._default_manager.filter(**{relation.field.name: project}).count()
        if count:
            counts[f"{model._meta.app_label}.{model._meta.model_name}"] = count
    return counts


@operation(
    "project.delete",
    ProjectRef,
    summary="Delete a project when nothing depends on it; referenced items stay in place.",
    requires_expected_state=True,
    idempotency_scope=edit_scope,
    authorize_replay=lambda ctx, p, stored: authorize(
        ctx.user, stored["workspace_id"], Perm.PROJECT_EDIT
    ),
)
def delete_project(ctx: Context, p: ProjectRef) -> dict:
    project = editable(ctx, p.project_id)
    blocking = dependents(project)
    if blocking:
        raise Conflict(
            "Records depend on this project; archive it instead.",
            details={"dependents": blocking},
        )
    result = {"project_id": str(project.id), "workspace_id": str(project.workspace_id)}
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                # The reference history guard admits deletion only for this project.
                cursor.execute(
                    "SELECT set_config('specmate.deleting_project', %s, true)", [str(project.id)]
                )
            project.delete()
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_config('specmate.deleting_project', '', true)")
    except IntegrityError:
        raise Conflict("A record began to depend on this project; archive it instead.") from None
    return {**result, "deleted": True}


def _target(kind: str, target_id: UUID):
    """Return (item, workspace id) for a reference target; item is None when missing."""
    from specmate.design.models import Definition, Revision
    from specmate.inventory.models import WorkBatch
    from specmate.physical_units.models import PhysicalUnit
    from specmate.sources.models import SourceBundle

    if kind == "definition":
        item = Definition.objects.filter(id=target_id).first()
        return item, item and item.workspace_id
    if kind == "revision":
        item = Revision.objects.select_related("definition").filter(id=target_id).first()
        return item, item and item.definition.workspace_id
    if kind == "source_bundle":
        item = SourceBundle.objects.filter(id=target_id).first()
        return item, item and item.workspace_id
    if kind == "physical_unit":
        item = PhysicalUnit.objects.filter(id=target_id).first()
        return item, item and item.workspace_id
    item = WorkBatch.objects.select_related("revision__definition").filter(id=target_id).first()
    return item, item and item.revision.definition.workspace_id


@operation(
    "project.add_reference",
    AddReference,
    summary="Record that a project uses a workspace item (floating definition or exact pin).",
    requires_expected_state=True,
    idempotency_scope=edit_scope,
    authorize_replay=edit_replay,
)
def add_reference(ctx: Context, p: AddReference) -> dict:
    project = editable(ctx, p.project_id)
    require_active(project)
    item, workspace_id = _target(p.kind, p.target_id)
    # A missing item and one outside the project's workspace are indistinguishable.
    if item is None or workspace_id != project.workspace_id:
        raise NotFound("Reference target not found.")
    try:
        with transaction.atomic():
            reference = ProjectReference.objects.create(
                project=project,
                kind=p.kind,
                role=p.role,
                note=p.note,
                added_by=ctx.user,
                request_id=ctx.request_id,
                **{p.kind: item},
            )
    except IntegrityError:
        raise Conflict("The project already references this item in this role.") from None
    return {"reference": reference_view(reference), "state": state(project)}


@operation(
    "project.remove_reference",
    RemoveReference,
    summary="Retire a project reference; the item and its other uses are unchanged.",
    requires_expected_state=True,
    idempotency_scope=edit_scope,
    authorize_replay=edit_replay,
)
def remove_reference(ctx: Context, p: RemoveReference) -> dict:
    project = editable(ctx, p.project_id)
    require_active(project)
    reference = (
        ProjectReference.objects.select_for_update()
        .filter(id=p.reference_id, project=project)
        .first()
    )
    if reference is None:
        raise NotFound("Reference not found.")
    if reference.removed_at is not None:
        raise ValidationFailed("The reference is already removed.")
    reference.removed_at = timezone.now()
    reference.removed_by = ctx.user
    reference.removal_request_id = ctx.request_id
    reference.removal_reason = p.reason
    reference.save(
        update_fields=["removed_at", "removed_by", "removal_request_id", "removal_reason"]
    )
    reference = ProjectReference.objects.select_related("added_by").get(id=reference.id)
    return {"reference": reference_view(reference), "state": state(project)}
