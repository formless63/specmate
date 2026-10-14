"""Workspace read contracts: library lists, projects and resolved project references.

The workspace is the privacy boundary. Every member reads the whole library; a project
only references items, so library rows carry no owning project. "Used in" lists the
projects whose active references name the item.
"""

import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

LibraryFamily = Literal[
    "definition", "source_bundle", "physical_unit", "stock_account", "fact_subject"
]
ReferenceKind = Literal[
    "definition", "revision", "source_bundle", "physical_unit", "work_batch", "release"
]
KIND_PATTERN = r"^[a-z][a-z0-9_]{0,49}$"
USED_IN_BOUND = 20


def _clean_text(value: str) -> str:
    if "\x00" in value:
        raise ValueError("Text cannot contain a null character.")
    return value


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ListLibrary(Query):
    """One family of workspace collection records, newest first.

    With ``project_id`` (navigation context) the items that project references come
    first; ``referenced_only`` limits the list to them. Context never changes access.
    """

    workspace_id: UUID | None = None
    family: LibraryFamily = "definition"
    kinds: list[str] = Field(default_factory=list, max_length=20)
    query: str = Field(default="", max_length=200)
    project_id: UUID | None = None
    referenced_only: bool = False
    after: str | None = Field(default=None, max_length=300)
    limit: int = Field(default=50, ge=1, le=100)

    @field_validator("query")
    @classmethod
    def clean_query(cls, value):
        return _clean_text(value)

    @field_validator("kinds")
    @classmethod
    def kind_slugs(cls, value):
        for kind in value:
            if not re.fullmatch(KIND_PATTERN, kind):
                raise ValueError("Kind must be a lowercase slug.")
        return sorted(set(value))


class ResolveLibraryRecord(Query):
    """Resolve one record of any library family by id (a deep link or a probe target).

    ``project_id`` is navigation context only: it sets ``referenced`` and never grants access.
    """

    workspace_id: UUID | None = None
    project_id: UUID | None = None


class UsedIn(BaseModel):
    reference_id: UUID
    project_id: UUID
    project_name: str
    archived: bool
    pin: Literal["floating", "exact"]
    revision: int | None = Field(description="Pinned revision number for an exact reference.")
    role: str


class LibraryRecord(BaseModel):
    record_id: UUID
    family: LibraryFamily
    kind: str | None = Field(description="Definition kind, source role, unit origin, …")
    label: str
    detail: str | None = None
    created_at: datetime
    latest_revision: int | None = Field(
        default=None, description="Highest frozen revision number; null when none is frozen."
    )
    latest_revision_id: UUID | None = Field(
        default=None, description="The latest frozen design revision, for an exact pin."
    )
    changed_at: datetime | None = Field(
        default=None, description="Latest draft change, when the family has drafts."
    )
    referenceable: bool = Field(description="Whether a project can reference this record.")
    referenced: bool | None = Field(
        description="Referenced by the context project; null without a project context."
    )
    used_in: list[UsedIn] = Field(description="Active project references, bounded.")
    used_in_total: int = Field(ge=0)


class LibraryPage(BaseModel):
    workspace_id: UUID
    family: LibraryFamily
    project_id: UUID | None
    results: list[LibraryRecord]
    next_after: str | None = Field(description="Opaque cursor; null on the last page.")


class ListWorkspaceProjects(Query):
    workspace_id: UUID | None = None
    query: str = Field(default="", max_length=200)
    include_archived: bool = False
    after: str | None = Field(default=None, max_length=400)
    limit: int = Field(default=100, ge=1, le=200)

    @field_validator("query")
    @classmethod
    def clean_query(cls, value):
        return _clean_text(value)


class KindCount(BaseModel):
    kind: str
    count: int = Field(ge=0)


class WorkspaceProject(BaseModel):
    project_id: UUID
    name: str
    purpose: str
    archived: bool
    created_by: str
    created_at: datetime
    references: list[KindCount] = Field(
        description="Active references by target kind (definitions also by definition kind)."
    )
    dependents: dict[str, int] = Field(
        description="Records that depend on the project; deletion needs none."
    )
    can_delete: bool = Field(description="The actor may delete it now (presentation aid).")


class WorkspaceProjectPage(BaseModel):
    workspace_id: UUID
    role: str
    permissions: list[str]
    results: list[WorkspaceProject]
    total: int = Field(ge=0, description="Projects matching the query.")
    next_after: str | None


class ResolvedReference(BaseModel):
    reference_id: UUID
    kind: ReferenceKind
    target_id: UUID
    pin: Literal["floating", "exact"]
    role: str
    note: str
    added_by: str
    added_at: datetime
    removed: bool
    removed_at: datetime | None
    removal_reason: str
    label: str
    item_kind: str | None = Field(description="Definition kind, source role, unit origin, …")
    definition_id: UUID | None = Field(description="Definition behind a definition/revision.")
    revision: int | None = Field(description="Pinned revision number (exact references).")
    latest_revision: int | None = Field(description="Latest frozen revision of the definition.")


class ProjectDetail(BaseModel):
    project_id: UUID
    workspace_id: UUID
    name: str
    purpose: str
    archived: bool
    archived_at: datetime | None
    created_by: str
    state: str
    permissions: list[str]
    references: list[ResolvedReference]
    dependents: dict[str, int]
    can_delete: bool
