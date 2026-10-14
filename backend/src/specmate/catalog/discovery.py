"""Workspace-scoped discovery and current-authority exact revision use queries.

Every read is limited to the actor's workspace. A project id is navigation context: at
project scope the items the project references come first and are marked, and where-used
lists the referencing projects next to captured pins. Neither widens nor narrows access.
"""

import json
from typing import Literal
from uuid import UUID

from django.db.models import BooleanField, ExpressionWrapper, Q
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from specmate.access.models import Project, ProjectReference
from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import ManufacturerVariant, PhysicalLot
from specmate.catalog.scope import (
    context_first,
    library_scope,
    references_bundle,
    references_definition,
    references_revision,
    searchable_workspaces,
)
from specmate.design.models import Definition, Revision, Snapshot
from specmate.design.operations import authorize_snapshot
from specmate.inventory.models import StockAccount
from specmate.operations import (
    Context,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
    operation,
)
from specmate.operations.core import ACCESS_AUTHENTICATED
from specmate.queries import get_revision
from specmate.sources.models import SourceBundle, SourceBundleRevision

SearchKind = Literal["project", "definition", "source_bundle", "variant", "lot", "stock"]
MAX_PROJECT_REFERENCES = 100


class SearchCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    query: str = Field(min_length=1, max_length=200)
    kind: SearchKind = "definition"
    # Optional scope: a workspace, or a project context (its referenced items first).
    workspace_id: UUID | None = None
    project_id: UUID | None = None
    after: UUID | None = None
    limit: int = Field(default=25, ge=1, le=100)

    @field_validator("query")
    @classmethod
    def unicode_query(cls, value):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("Search query must contain valid Unicode.") from None
        if "\x00" in value:
            raise ValueError("Search query cannot contain a null character.")
        return value


class WhereUsed(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision_id: UUID
    # Optional project context: its own uses are listed first and marked.
    project_id: UUID | None = None
    after: UUID | None = None
    limit: int = Field(default=25, ge=1, le=100)


class RevisionImpact(WhereUsed):
    candidate_revision_id: UUID


class RevisionLabels(BaseModel):
    """Display identity for exact design and source revision IDs the caller already holds."""

    model_config = ConfigDict(extra="forbid")
    revision_ids: list[UUID] = Field(default_factory=list, max_length=50)
    source_revision_ids: list[UUID] = Field(default_factory=list, max_length=50)

    @field_validator("revision_ids", "source_revision_ids")
    @classmethod
    def unique_ids(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("Revision IDs must be unique.")
        return value

    @model_validator(mode="after")
    def at_least_one(self):
        if not self.revision_ids and not self.source_revision_ids:
            raise ValueError("At least one revision ID is required.")
        return self


def visible_page(queryset, payload, render):
    """One bounded page in stable id order from a cursor inside the same scoped query.

    The query is already limited to the actor's workspace; a cursor outside it is
    indistinguishable from a missing one.
    """
    page = context_first(queryset, None, payload.after, cursor_error="Search cursor not found.")
    return _page(page, payload.limit, render, mark=False)


def _page(ordered, limit, render, *, mark):
    rows = list(ordered[: limit + 1])
    results = []
    for row in rows[:limit]:
        result = render(row)
        if mark:
            result["in_project"] = bool(row.in_project)
        results.append(result)
    return {
        "results": results,
        "next_after": results[-1]["record_id"] if len(rows) > limit else None,
    }


def search_catalog(user, payload):
    workspaces, project = searchable_workspaces(user, payload.workspace_id, payload.project_id)
    text = payload.query
    kind = payload.kind
    referenced = None
    if kind == "project":
        query = Project.objects.filter(workspace__in=workspaces, name__icontains=text)
        if project is not None:
            referenced = ExpressionWrapper(Q(id=project.id), output_field=BooleanField())

        def render(row):
            return {
                "record_id": str(row.id),
                "project_id": str(row.id),
                "workspace_id": str(row.workspace_id),
                "label": row.name,
                "archived": row.archived_at is not None,
            }

    elif kind == "definition":
        query = Definition.objects.filter(workspace__in=workspaces, name__icontains=text)
        if project is not None:
            referenced = references_definition(project)

        def render(row):
            return {
                "record_id": str(row.id),
                "workspace_id": str(row.workspace_id),
                "label": row.name,
                "definition_kind": row.kind,
            }

    elif kind == "source_bundle":
        matching = SourceBundle.objects.filter(
            Q(name__icontains=text) | Q(revisions__files__path__icontains=text),
            workspace__in=workspaces,
        ).values("id")
        query = SourceBundle.objects.filter(id__in=matching)
        if project is not None:
            referenced = references_bundle(project)

        def render(row):
            return {
                "record_id": str(row.id),
                "workspace_id": str(row.workspace_id),
                "label": row.name,
                "role": row.role,
            }

    else:
        if kind == "variant":
            query = ManufacturerVariant.objects.select_related("revision__definition").filter(
                Q(manufacturer__icontains=text) | Q(part_number__icontains=text),
                revision__definition__workspace__in=workspaces,
            )
            prefix = ""
        elif kind == "lot":
            query = PhysicalLot.objects.select_related("revision__definition").filter(
                revision__definition__workspace__in=workspaces,
                label__icontains=text,
            )
            prefix = ""
        else:
            query = StockAccount.objects.select_related(
                "lot__revision__definition", "location"
            ).filter(
                Q(lot__label__icontains=text) | Q(location__name__icontains=text),
                location__workspace__in=workspaces,
            )
            prefix = "lot__"
        if project is not None:
            referenced = references_revision(
                project, f"{prefix}revision_id", f"{prefix}revision__definition_id"
            )

        def render(row):
            revision = row.lot.revision if kind == "stock" else row.revision
            result = {
                "record_id": str(row.id),
                "workspace_id": str(
                    row.location.workspace_id
                    if kind == "stock"
                    else revision.definition.workspace_id
                ),
                "revision_id": str(revision.id),
                "definition_id": str(revision.definition_id),
                "label": f"{row.manufacturer} / {row.part_number}"
                if kind == "variant"
                else f"{row.lot.label} · {row.location.name}"
                if kind == "stock"
                else row.label,
            }
            if kind == "variant":
                result["association_basis"] = row.association_basis
            return result

    ordered = context_first(
        query, referenced, payload.after, cursor_error="Search cursor not found."
    )
    page = _page(ordered, payload.limit, render, mark=project is not None)
    return {
        "kind": kind,
        "query": text,
        "project_id": str(project.id) if project is not None else None,
        **page,
    }


def project_uses(revision, project=None):
    """Projects that declare a use of this revision: exact pins or floating references.

    A project reference is a declared use, not a captured pin. The project context, if
    any, comes first; the list is bounded and says so when truncated.
    """
    query = ProjectReference.objects.filter(
        removed_at__isnull=True, project__workspace_id=revision.definition.workspace_id
    ).filter(
        Q(kind="revision", revision_id=revision.id)
        | Q(kind="definition", definition_id=revision.definition_id)
    )
    order = ["project__name", "project_id", "added_at", "id"]
    if project is not None:
        query = query.annotate(
            in_context=ExpressionWrapper(Q(project_id=project.id), output_field=BooleanField())
        )
        order.insert(0, "-in_context")
    rows = list(query.select_related("project").order_by(*order)[: MAX_PROJECT_REFERENCES + 1])
    return {
        "project_references": [
            {
                "reference_id": str(row.id),
                "project_id": str(row.project_id),
                "project_name": row.project.name,
                "archived": row.project.archived_at is not None,
                "kind": row.kind,
                "relation": "project_reference_exact"
                if row.kind == ProjectReference.Kind.REVISION
                else "project_reference_floating",
                "role": row.role,
                "in_project": project is not None and row.project_id == project.id,
            }
            for row in rows[:MAX_PROJECT_REFERENCES]
        ],
        "project_references_truncated": len(rows) > MAX_PROJECT_REFERENCES,
    }


def where_used(user, payload):
    """Captured exact pins (parent definitions' snapshots) and referencing projects.

    Pins describe retained dependency closure, not occurrence counts or compatibility.
    Reading the revision authorizes the workspace; every pin and reference stays inside it.
    """
    revision = get_revision(user, payload.revision_id)
    project = None
    if payload.project_id is not None:
        _, project = library_scope(user, revision.definition.workspace_id, payload.project_id)
    query = Snapshot.objects.select_related("definition").filter(
        dependencies__revision_id=payload.revision_id,
        definition__workspace_id=revision.definition.workspace_id,
    )
    referenced = references_definition(project, "definition_id") if project else None
    ordered = context_first(
        query, referenced, payload.after, cursor_error="Search cursor not found."
    )

    def render(snapshot):
        return {
            "record_id": str(snapshot.id),
            "snapshot_id": str(snapshot.id),
            "workspace_id": str(snapshot.definition.workspace_id),
            "definition_id": str(snapshot.definition_id),
            "definition_kind": snapshot.definition.kind,
            "label": snapshot.definition.name,
            "relation": "exact_revision_pin",
        }

    return {
        "revision_id": str(payload.revision_id),
        "workspace_id": str(revision.definition.workspace_id),
        "project_id": str(project.id) if project is not None else None,
        **_page(ordered, payload.limit, render, mark=project is not None),
        **project_uses(revision, project),
    }


def revision_impact(user, payload):
    current = get_revision(user, payload.revision_id)
    candidate = get_revision(user, payload.candidate_revision_id)
    # Authorize both complete closures before comparing identities or numbering.
    if current.definition_id != candidate.definition_id:
        raise ValidationFailed("Upgrade candidate must belong to the same definition.")
    if candidate.number <= current.number:
        raise ValidationFailed("Upgrade candidate must be a later frozen revision.")
    uses = where_used(user, payload)
    return {
        **uses,
        "definition_id": str(current.definition_id),
        "definition_kind": current.definition.kind,
        "current_number": current.number,
        "candidate_revision_id": str(candidate.id),
        "candidate_number": candidate.number,
        "current_sha256": current.snapshot.sha256,
        "candidate_sha256": candidate.snapshot.sha256,
        "content_changed": json.loads(bytes(current.snapshot.canonical))["content"]
        != json.loads(bytes(candidate.snapshot.canonical))["content"],
        "dependency_pins_changed": set(
            current.snapshot.dependencies.values_list("revision_id", flat=True)
        )
        != set(candidate.snapshot.dependencies.values_list("revision_id", flat=True)),
        "adoption": "new_owning_draft_required",
        "compatibility": "not_evaluated",
        "existing_pins": "retained",
    }


def revision_labels(user, payload):
    """Name, kind and number for each exact revision the actor may read.

    Authorization matches reading the revision itself (workspace read plus typed
    validation of the pinned closure). A revision that is missing, outside the actor's
    workspace or not readable yields the same unreadable entry, with no name, kind or
    number.
    """
    authorized: set = set()
    labels = []
    for revision_id in payload.revision_ids:
        entry = {"revision_id": str(revision_id), "readable": False}
        revision = (
            Revision.objects.select_related("definition", "snapshot__definition")
            .filter(id=revision_id)
            .first()
        )
        if revision is not None:
            try:
                authorize(user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
                authorize_snapshot(user, revision.snapshot, _authorized=authorized)
            except (NotFound, PermissionDenied):
                pass
            else:
                entry.update(
                    readable=True,
                    definition_id=str(revision.definition_id),
                    name=revision.definition.name,
                    kind=revision.definition.kind,
                    number=revision.number,
                )
        labels.append(entry)
    return {"labels": labels, "source_labels": source_revision_labels(user, payload)}


def source_revision_labels(user, payload):
    """Source revision names use the same current authority as reading the source revision."""
    from specmate.catalog_matching.queries import current_actor
    from specmate.sources.authority import authorize_revision

    rows = []
    for revision_id in payload.source_revision_ids:
        entry = {"revision_id": str(revision_id), "readable": False}
        revision = (
            SourceBundleRevision.objects.select_related("bundle").filter(id=revision_id).first()
        )
        if revision is not None:
            try:
                authorize_revision(current_actor(user), revision)
            except (NotFound, PermissionDenied, Unauthenticated):
                pass
            else:
                entry.update(
                    readable=True,
                    bundle_id=str(revision.bundle_id),
                    name=revision.bundle.name,
                    kind=revision.bundle.role,
                    number=revision.number,
                )
        rows.append(entry)
    return rows


@operation(
    "catalog.search",
    SearchCatalog,
    supports_idempotency=False,
    summary="Search the workspace library; a project context lists its referenced items first.",
    access=Perm.WORKSPACE_READ,
)
def search(ctx: Context, payload: SearchCatalog):
    return search_catalog(ctx.user, payload)


@operation(
    "catalog.where_used",
    WhereUsed,
    supports_idempotency=False,
    summary="List exact snapshot pins and referencing projects of a revision in its workspace.",
    access=Perm.WORKSPACE_READ,
)
def uses(ctx: Context, payload: WhereUsed):
    return where_used(ctx.user, payload)


@operation(
    "catalog.revision_impact",
    RevisionImpact,
    supports_idempotency=False,
    summary="Compare exact revisions and list retained parent pins and project references.",
    access=Perm.WORKSPACE_READ,
)
def impact(ctx: Context, payload: RevisionImpact):
    return revision_impact(ctx.user, payload)


@operation(
    "catalog.revision_labels",
    RevisionLabels,
    supports_idempotency=False,
    summary="Resolve display names for exact revisions the actor can currently read.",
    access=ACCESS_AUTHENTICATED,
)
def labels(ctx: Context, payload: RevisionLabels):
    return revision_labels(ctx.user, payload)
