"""Membership-filtered discovery and current-authority exact revision use queries."""

import json
from typing import Literal
from uuid import UUID

from django.db.models import Q
from pydantic import BaseModel, ConfigDict, Field, field_validator

from specmate.access.permissions import Perm, authorize, visible_projects
from specmate.catalog.models import ManufacturerVariant, PhysicalLot
from specmate.design.models import Definition, Revision, Snapshot
from specmate.design.operations import authorize_snapshot
from specmate.inventory.models import StockAccount
from specmate.operations import (
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)
from specmate.queries import get_revision
from specmate.sources.models import SourceBundle

SearchKind = Literal["project", "definition", "source_bundle", "variant", "lot", "stock"]


class SearchCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    query: str = Field(min_length=1, max_length=200)
    kind: SearchKind = "definition"
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
    after: UUID | None = None
    limit: int = Field(default=25, ge=1, le=100)


class RevisionImpact(WhereUsed):
    candidate_revision_id: UUID


class RevisionLabels(BaseModel):
    """Display identity for exact revision IDs the caller already holds."""

    model_config = ConfigDict(extra="forbid")
    revision_ids: list[UUID] = Field(min_length=1, max_length=50)

    @field_validator("revision_ids")
    @classmethod
    def unique_ids(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("Revision IDs must be unique.")
        return value


def visible_page(queryset, payload, render):
    """Advance only from a disclosed record; hidden rows never become a cursor or count.

    Filtering happens before the page is selected. A denied reference closure omits the
    candidate instead of poisoning an otherwise authorized search or revealing a count.
    """
    if payload.after:
        cursor = queryset.filter(id=payload.after).first()
        if cursor is None:
            raise NotFound("Search cursor not found.")
        try:
            render(cursor)
        except NotFound:
            raise NotFound("Search cursor not found.") from None
        queryset = queryset.filter(id__gt=payload.after)
    rows = []
    for candidate in queryset.order_by("id").iterator(chunk_size=100):
        try:
            row = render(candidate)
        except NotFound:
            continue
        rows.append(row)
        if len(rows) > payload.limit:
            break
    selected = rows[: payload.limit]
    return {
        "results": selected,
        "next_after": selected[-1]["record_id"] if len(rows) > payload.limit else None,
    }


def search_catalog(user, payload):
    projects = visible_projects(user)
    if payload.project_id:
        authorize(user, payload.project_id, Perm.PROJECT_READ)
        projects = projects.filter(id=payload.project_id)
    text = payload.query
    kind = payload.kind
    if kind == "project":
        query = projects.filter(name__icontains=text)

        def render(row):
            authorize(user, row.id, Perm.PROJECT_READ)
            return {"record_id": str(row.id), "project_id": str(row.id), "label": row.name}

    elif kind == "definition":
        query = Definition.objects.filter(project__in=projects, name__icontains=text)

        def render(row):
            authorize(user, row.project_id, Perm.PROJECT_READ)
            return {
                "record_id": str(row.id),
                "project_id": str(row.project_id),
                "label": row.name,
                "definition_kind": row.kind,
            }

    elif kind == "source_bundle":
        query = SourceBundle.objects.filter(
            Q(name__icontains=text) | Q(revisions__files__path__icontains=text),
            project__in=projects,
        ).distinct()

        def render(row):
            authorize(user, row.project_id, Perm.PROJECT_READ)
            return {
                "record_id": str(row.id),
                "project_id": str(row.project_id),
                "label": row.name,
                "role": row.role,
            }

    else:
        if kind == "variant":
            query = ManufacturerVariant.objects.select_related("revision__definition").filter(
                Q(manufacturer__icontains=text) | Q(part_number__icontains=text),
                revision__definition__project__in=projects,
            )
        elif kind == "lot":
            query = PhysicalLot.objects.select_related("revision__definition").filter(
                revision__definition__project__in=projects,
                label__icontains=text,
            )
        else:
            query = StockAccount.objects.select_related(
                "lot__revision__definition", "location"
            ).filter(
                Q(lot__label__icontains=text) | Q(location__name__icontains=text),
                location__project__in=projects,
            )

        def render(row):
            from specmate.inventory.queries import get_account

            revision = row.lot.revision if kind == "stock" else row.revision
            if kind == "stock":
                get_account(user, row.id)
            else:
                get_revision(user, revision.id)
            result = {
                "record_id": str(row.id),
                "project_id": str(
                    row.location.project_id if kind == "stock" else revision.definition.project_id
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

    return {"kind": kind, "query": text, **visible_page(query, payload, render)}


def where_used(user, payload):
    get_revision(user, payload.revision_id)
    # A pin is evidence of a captured dependency, not an occurrence count or compatibility.
    query = Snapshot.objects.select_related("definition").filter(
        dependencies__revision_id=payload.revision_id,
        definition__project__in=visible_projects(user),
    )

    def render(snapshot):
        authorize_snapshot(user, snapshot)
        return {
            "record_id": str(snapshot.id),
            "snapshot_id": str(snapshot.id),
            "project_id": str(snapshot.definition.project_id),
            "definition_id": str(snapshot.definition_id),
            "label": snapshot.definition.name,
            "relation": "exact_revision_pin",
        }

    return {"revision_id": str(payload.revision_id), **visible_page(query, payload, render)}


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

    Authorization matches reading the revision itself (project read plus the complete
    pinned closure). A revision that is missing, outside the actor's projects or not
    fully readable yields the same unreadable entry, with no name, kind or number.
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
                authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
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
    return {"labels": labels}


@operation(
    "catalog.search",
    SearchCatalog,
    supports_idempotency=False,
    summary="Search currently authorized engineering identities and source records.",
)
def search(ctx: Context, payload: SearchCatalog):
    return search_catalog(ctx.user, payload)


@operation(
    "catalog.where_used",
    WhereUsed,
    supports_idempotency=False,
    summary="List authorized exact snapshot pins without disclosing inaccessible parents.",
)
def uses(ctx: Context, payload: WhereUsed):
    return where_used(ctx.user, payload)


@operation(
    "catalog.revision_impact",
    RevisionImpact,
    supports_idempotency=False,
    summary="Compare exact revisions and list current authorized retained parent pins.",
)
def impact(ctx: Context, payload: RevisionImpact):
    return revision_impact(ctx.user, payload)


@operation(
    "catalog.revision_labels",
    RevisionLabels,
    supports_idempotency=False,
    summary="Resolve display names for exact revisions the actor can currently read.",
)
def labels(ctx: Context, payload: RevisionLabels):
    return revision_labels(ctx.user, payload)
