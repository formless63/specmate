"""Workspace reads: the library, the project list and resolved project references.

The workspace is the privacy boundary: one membership check admits every row in it and a
non-member gets NotFound, never an empty list that confirms existence. Library rows have
no owning project; "used in" comes from active project references. Each page is served
by a fixed number of queries regardless of how many projects exist. Nothing here mutates.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections import defaultdict
from datetime import datetime
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import (
    BooleanField,
    Count,
    Exists,
    Max,
    OuterRef,
    Q,
    Subquery,
    Value,
)
from django.db.models.functions import Lower

from specmate.access.models import Project, ProjectReference, Workspace
from specmate.access.permissions import (
    Perm,
    authorize,
    authorize_project,
    held_permissions,
    membership,
)
from specmate.access.projects import dependents_by_project, may_delete, project_view
from specmate.access.workspaces import actor_workspace_id
from specmate.design.models import Definition, Draft, Revision
from specmate.operations import NotFound, Unauthenticated, ValidationFailed
from specmate.workspace.contracts import (
    USED_IN_BOUND,
    KindCount,
    LibraryPage,
    LibraryRecord,
    ListLibrary,
    ListWorkspaceProjects,
    ProjectDetail,
    ResolvedReference,
    ResolveLibraryRecord,
    UsedIn,
    WorkspaceProject,
    WorkspaceProjectPage,
)


def _actor(user):
    if user is None or not user.is_authenticated:
        raise Unauthenticated("Authentication required.")
    actor = get_user_model().objects.filter(pk=user.pk, is_active=True).first()
    if actor is None:
        raise Unauthenticated("Actor is not active.")
    return actor


def _workspace(actor, workspace_id) -> Workspace:
    return authorize(actor, actor_workspace_id(actor, workspace_id), Perm.WORKSPACE_READ)


def _context(workspace: Workspace, project_id) -> Project | None:
    if project_id is None:
        return None
    project = Project.objects.filter(id=project_id, workspace=workspace).first()
    if project is None:
        # Same wording as a missing project: no existence signal across workspaces.
        raise NotFound("Project not found.")
    return project


def _encode(values: list) -> str:
    raw = json.dumps(values, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode(token: str, size: int) -> list:
    try:
        padded = token + "=" * (-len(token) % 4)
        values = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        raise ValidationFailed("Invalid cursor.") from None
    if not isinstance(values, list) or len(values) != size:
        raise ValidationFailed("Invalid cursor.")
    if not all(isinstance(value, str) for value in values):
        raise ValidationFailed("Invalid cursor.")
    return values


def _active_references(project: Project):
    return ProjectReference.objects.filter(project=project, removed_at__isnull=True)


# Each family: (base queryset, "referenced by the context project" condition or None,
# row renderer, used-in loader). Families without a reference kind are never referenced.


def _definitions(workspace, payload, context):
    latest = Revision.objects.filter(definition=OuterRef("pk")).order_by("-number")
    changed = Draft.objects.filter(definition=OuterRef("pk")).order_by("-updated_at")
    query = Definition.objects.filter(workspace=workspace).annotate(
        latest_revision=Subquery(latest.values("number")[:1]),
        latest_revision_id=Subquery(latest.values("id")[:1]),
        changed_at=Subquery(changed.values("updated_at")[:1]),
    )
    if payload.kinds:
        query = query.filter(kind__in=payload.kinds)
    if payload.query:
        query = query.filter(name__icontains=payload.query)
    referenced = context and _active_references(context).filter(
        Q(definition_id=OuterRef("pk")) | Q(revision__definition_id=OuterRef("pk"))
    )

    def render(row):
        return {
            "record_id": row.id,
            "family": "definition",
            "kind": row.kind,
            "label": row.name,
            "created_at": row.created_at,
            "latest_revision": row.latest_revision,
            "latest_revision_id": row.latest_revision_id,
            "changed_at": row.changed_at,
        }

    def used_in(ids):
        references = ProjectReference.objects.filter(
            Q(definition_id__in=ids) | Q(revision__definition_id__in=ids)
        )
        return references, lambda ref: ref.definition_id or ref.revision.definition_id

    return query, referenced, render, used_in


def _source_bundles(workspace, payload, context):
    from specmate.sources.models import SourceBundle, SourceBundleRevision

    latest = SourceBundleRevision.objects.filter(bundle=OuterRef("pk")).order_by("-number")
    query = SourceBundle.objects.filter(workspace=workspace).annotate(
        latest_revision=Subquery(latest.values("number")[:1]),
        changed_at=Subquery(latest.values("created_at")[:1]),
    )
    if payload.kinds:
        query = query.filter(role__in=payload.kinds)
    if payload.query:
        query = query.filter(name__icontains=payload.query)
    referenced = context and _active_references(context).filter(source_bundle_id=OuterRef("pk"))

    def render(row):
        return {
            "record_id": row.id,
            "family": "source_bundle",
            "kind": row.role,
            "label": row.name,
            "detail": "Derivative" if row.derived_from_id else "Original",
            "created_at": row.created_at,
            "latest_revision": row.latest_revision,
            "changed_at": row.changed_at,
        }

    def used_in(ids):
        return ProjectReference.objects.filter(
            source_bundle_id__in=ids
        ), lambda ref: ref.source_bundle_id

    return query, referenced, render, used_in


def _physical_units(workspace, payload, context):
    from specmate.physical_units.models import PhysicalUnit

    query = PhysicalUnit.objects.filter(workspace=workspace).select_related("revision__definition")
    if payload.kinds:
        query = query.filter(origin__in=payload.kinds)
    if payload.query:
        query = query.filter(serial__icontains=payload.query)
    referenced = context and _active_references(context).filter(physical_unit_id=OuterRef("pk"))

    def render(row):
        return {
            "record_id": row.id,
            "family": "physical_unit",
            "kind": row.origin,
            "label": row.serial,
            "detail": f"{row.revision.definition.name} r{row.revision.number}",
            "created_at": row.created_at,
        }

    def used_in(ids):
        return ProjectReference.objects.filter(
            physical_unit_id__in=ids
        ), lambda ref: ref.physical_unit_id

    return query, referenced, render, used_in


def _stock_accounts(workspace, payload, context):
    from specmate.inventory.models import StockAccount

    query = StockAccount.objects.filter(location__workspace=workspace).select_related(
        "lot__revision__definition", "location"
    )
    if payload.kinds:
        query = query.filter(dimension__in=payload.kinds)
    if payload.query:
        query = query.filter(
            Q(lot__label__icontains=payload.query) | Q(location__name__icontains=payload.query)
        )

    def render(row):
        revision = row.lot.revision
        return {
            "record_id": row.id,
            "family": "stock_account",
            "kind": row.dimension,
            "label": row.lot.label,
            "detail": f"{revision.definition.name} r{revision.number} · {row.location.name}",
            "created_at": row.created_at,
        }

    return query, None, render, None


def _fact_subjects(workspace, payload, context):
    from specmate.facts.models import FactSubject

    query = (
        FactSubject.objects.filter(workspace=workspace)
        .select_related(
            "definition", "revision__definition", "physical_unit", "snapshot__definition"
        )
        .annotate(assertion_count=Count("assertions"))
    )
    if payload.kinds:
        query = query.filter(kind__in=payload.kinds)
    if payload.query:
        query = query.filter(
            Q(definition__name__icontains=payload.query)
            | Q(revision__definition__name__icontains=payload.query)
            | Q(physical_unit__serial__icontains=payload.query)
        )

    def render(row):
        if row.kind == "definition" and row.definition:
            label = row.definition.name
        elif row.kind == "revision" and row.revision:
            label = f"{row.revision.definition.name} r{row.revision.number}"
        elif row.kind == "physical_unit" and row.physical_unit:
            label = row.physical_unit.serial
        elif row.kind == "occurrence" and row.snapshot:
            label = f"{row.snapshot.definition.name} / {'/'.join(row.path)}"
        else:
            label = row.kind.replace("_", " ")
        if row.feature_id:
            label = f"{label} / {row.feature_id}"
        return {
            "record_id": row.id,
            "family": "fact_subject",
            "kind": row.kind,
            "label": label,
            "detail": f"{row.assertion_count} assertions",
            "created_at": row.created_at,
        }

    return query, None, render, None


FAMILIES = {
    "definition": _definitions,
    "source_bundle": _source_bundles,
    "physical_unit": _physical_units,
    "stock_account": _stock_accounts,
    "fact_subject": _fact_subjects,
}


def _used_in(loader, ids) -> dict:
    """Active references naming each record, bounded per record, archived projects marked."""
    if loader is None or not ids:
        return {}
    references, target = loader(ids)
    rows = (
        references.filter(removed_at__isnull=True)
        .select_related("project", "revision")
        .order_by(Lower("project__name"), "project_id", "added_at", "id")
    )
    result: dict = defaultdict(list)
    for ref in rows:
        result[target(ref)].append(
            UsedIn(
                reference_id=ref.id,
                project_id=ref.project_id,
                project_name=ref.project.name,
                archived=ref.project.archived_at is not None,
                pin="exact" if ref.kind == "revision" else "floating",
                revision=ref.revision.number if ref.revision_id else None,
                role=ref.role,
            )
        )
    return result


def _page_after(query, after: str | None, with_context: bool):
    if after is None:
        return query
    if with_context:
        flag, created, record = _decode(after, 3)
    else:
        flag, (created, record) = None, _decode(after, 2)
    try:
        created, record = datetime.fromisoformat(created), UUID(record)
    except ValueError:
        raise ValidationFailed("Invalid cursor.") from None
    older = Q(created_at__lt=created) | Q(created_at=created, id__lt=record)
    if flag is None:
        return query.filter(older)
    if flag not in ("0", "1"):
        raise ValidationFailed("Invalid cursor.")
    if flag == "1":
        return query.filter(Q(referenced=False) | (Q(referenced=True) & older))
    return query.filter(Q(referenced=False) & older)


def _records(rows, render, loader, context) -> list[LibraryRecord]:
    used = _used_in(loader, [row.id for row in rows])
    results = []
    for row in rows:
        uses = used.get(row.id, [])
        results.append(
            LibraryRecord(
                **render(row),
                referenceable=loader is not None,
                referenced=bool(row.referenced) if context is not None else None,
                used_in=uses[:USED_IN_BOUND],
                used_in_total=len(uses),
            )
        )
    return results


def _referenced_flag(referenced):
    if referenced is None:
        return Value(False, output_field=BooleanField())
    return Exists(referenced)


def list_library(user, payload: ListLibrary) -> dict:
    """One workspace collection family; a context project's references come first."""
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    context = _context(workspace, payload.project_id)
    query, referenced, render, loader = FAMILIES[payload.family](workspace, payload, context)
    if context is not None:
        query = query.annotate(referenced=_referenced_flag(referenced))
        if payload.referenced_only:
            query = query.filter(referenced=True)
        query = query.order_by("-referenced", "-created_at", "-id")
    else:
        query = query.order_by("-created_at", "-id")
    query = _page_after(query, payload.after, context is not None)
    rows = list(query[: payload.limit + 1])
    page = rows[: payload.limit]
    results = _records(page, render, loader, context)
    next_after = None
    if len(rows) > payload.limit and page:
        last = page[-1]
        stamp = [last.created_at.isoformat(), str(last.id)]
        next_after = _encode(["1" if last.referenced else "0", *stamp] if context else stamp)
    return LibraryPage(
        workspace_id=workspace.id,
        family=payload.family,
        project_id=context.id if context else None,
        results=results,
        next_after=next_after,
    ).model_dump(mode="json")


def _reference_counts(project_ids) -> dict:
    counts: dict = defaultdict(list)
    rows = (
        ProjectReference.objects.filter(project_id__in=project_ids, removed_at__isnull=True)
        .order_by()
        .values("project_id", "kind")
        .annotate(n=Count("id"))
        .order_by("project_id", "kind")
    )
    for row in rows:
        counts[row["project_id"]].append(KindCount(kind=row["kind"], count=row["n"]))
    return counts


def list_projects(user, payload: ListWorkspaceProjects) -> dict:
    """Every project in the workspace by name, with reference and dependent counts."""
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    held = held_permissions(actor, workspace.id)
    query = (
        Project.objects.filter(workspace=workspace)
        .select_related("created_by")
        .annotate(sort_name=Lower("name"))
    )
    if not payload.include_archived:
        query = query.filter(archived_at__isnull=True)
    if payload.query:
        query = query.filter(name__icontains=payload.query)
    total = query.count()
    query = query.order_by("sort_name", "id")
    if payload.after:
        name, project = _decode(payload.after, 2)
        try:
            project = UUID(project)
        except ValueError:
            raise ValidationFailed("Invalid cursor.") from None
        query = query.filter(Q(sort_name__gt=name) | Q(sort_name=name, id__gt=project))
    rows = list(query[: payload.limit + 1])
    page = rows[: payload.limit]
    ids = [project.id for project in page]
    references = _reference_counts(ids)
    blocking = dependents_by_project(ids)
    results = [
        WorkspaceProject(
            project_id=project.id,
            name=project.name,
            purpose=project.purpose,
            archived=project.archived_at is not None,
            created_by=project.created_by.get_username(),
            created_at=project.created_at,
            references=references.get(project.id, []),
            dependents=blocking.get(project.id, {}),
            can_delete=may_delete(actor, project, held) and not blocking.get(project.id),
        )
        for project in page
    ]
    next_after = (
        _encode([page[-1].sort_name, str(page[-1].id)])
        if len(rows) > payload.limit and page
        else None
    )
    own = membership(actor, workspace.id)
    return WorkspaceProjectPage(
        workspace_id=workspace.id,
        role=own.role,
        permissions=sorted(p.value for p in held),
        results=results,
        total=total,
        next_after=next_after,
    ).model_dump(mode="json")


def _labels(references: list[ProjectReference]) -> dict:
    """Resolve every reference target in a fixed number of queries."""
    from specmate.inventory.models import WorkBatch
    from specmate.physical_units.models import PhysicalUnit
    from specmate.releases.models import Release
    from specmate.sources.models import SourceBundle

    def ids(kind):
        return [ref.target_id for ref in references if ref.kind == kind]

    definitions = Definition.objects.in_bulk(ids("definition"))
    revisions = Revision.objects.select_related("definition").in_bulk(ids("revision"))
    bundles = SourceBundle.objects.in_bulk(ids("source_bundle"))
    units = PhysicalUnit.objects.select_related("revision__definition").in_bulk(
        ids("physical_unit")
    )
    batches = WorkBatch.objects.select_related("revision__definition").in_bulk(ids("work_batch"))
    releases = Release.objects.in_bulk(ids("release"))
    definition_ids = set(definitions) | {r.definition_id for r in revisions.values()}
    latest = dict(
        Revision.objects.filter(definition_id__in=definition_ids)
        .order_by()
        .values("definition_id")
        .annotate(n=Max("number"))
        .values_list("definition_id", "n")
    )
    result = {}
    for ref in references:
        target = ref.target_id
        label, item_kind, definition_id, number = "Unknown item", None, None, None
        if ref.kind == "definition" and target in definitions:
            item = definitions[target]
            label, item_kind, definition_id = item.name, item.kind, item.id
        elif ref.kind == "revision" and target in revisions:
            item = revisions[target]
            label, item_kind = item.definition.name, item.definition.kind
            definition_id, number = item.definition_id, item.number
        elif ref.kind == "source_bundle" and target in bundles:
            item = bundles[target]
            label, item_kind = item.name, item.role
        elif ref.kind == "physical_unit" and target in units:
            item = units[target]
            label, item_kind = item.serial, item.origin
            number = item.revision.number
        elif ref.kind == "work_batch" and target in batches:
            item = batches[target]
            label, item_kind, number = item.label, item.kind, item.revision.number
        elif ref.kind == "release" and target in releases:
            label, item_kind = releases[target].name, "release"
        result[ref.id] = {
            "label": label,
            "item_kind": item_kind,
            "definition_id": definition_id,
            "revision": number if ref.kind == "revision" else None,
            "latest_revision": latest.get(definition_id) if definition_id else None,
        }
    return result


def project_detail(user, project_id: UUID, *, include_removed: bool = False) -> dict:
    """A project with its references resolved to item labels, and its delete eligibility."""
    actor = _actor(user)
    project = authorize_project(actor, project_id, Perm.WORKSPACE_READ)
    held = held_permissions(actor, project.workspace_id)
    view = project_view(project, include_removed=include_removed)
    references = list(
        ProjectReference.objects.filter(id__in=[r["reference_id"] for r in view["references"]])
    )
    labels = _labels(references)
    blocking = dependents_by_project([project.id])[project.id]
    resolved = [
        ResolvedReference(**row, **labels[UUID(row["reference_id"])]) for row in view["references"]
    ]
    return ProjectDetail(
        **{key: view[key] for key in ("project_id", "workspace_id", "name", "purpose")},
        archived=view["archived"],
        archived_at=view["archived_at"],
        created_by=view["created_by"],
        state=view["state"],
        permissions=sorted(p.value for p in held),
        references=resolved,
        dependents=blocking,
        can_delete=may_delete(actor, project, held) and not blocking,
    ).model_dump(mode="json")


def library_record(user, record_id: UUID, payload: ResolveLibraryRecord) -> dict:
    """One workspace collection record by id, whatever its family (deep links, probes).

    A record outside the actor's workspace and a missing record raise the same NotFound,
    so a link never confirms that something exists elsewhere. Context never changes access.
    """
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    context = _context(workspace, payload.project_id)
    for factory in FAMILIES.values():
        query, referenced, render, loader = factory(workspace, ListLibrary(), context)
        if context is not None:
            query = query.annotate(referenced=_referenced_flag(referenced))
        row = query.filter(id=record_id).first()
        if row is not None:
            return _records([row], render, loader, context)[0].model_dump(mode="json")
    raise NotFound("Item not found.")
