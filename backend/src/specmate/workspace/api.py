"""Workspace reads: the library, the project list and resolved project references.

Every route is a thin adapter over ``specmate.workspace.queries``; mutations (projects,
references, membership) go through the shared operation endpoint.
"""

from uuid import UUID

from ninja import Query, Router

from specmate.queries import list_definitions
from specmate.workspace.contracts import ListLibrary, ListWorkspaceProjects, ResolveLibraryRecord
from specmate.workspace.design_contracts import ListDesigns
from specmate.workspace.queries import library_record, list_library, list_projects, project_detail

router = Router(tags=["workspace"])


@router.get("/designs")
def designs(request, payload: Query[ListDesigns]):
    from specmate.workspace.designs import list_designs

    return list_designs(request.user, payload)


@router.get("/library")
def library(request, payload: Query[ListLibrary]):
    return list_library(request.user, payload)


@router.get("/library/{record_id}")
def library_item(request, record_id: UUID, payload: Query[ResolveLibraryRecord]):
    """One library record of any family; unreadable and missing records look the same."""
    return library_record(request.user, record_id, payload)


@router.get("/definitions")
def definitions(request, workspace_id: UUID | None = None):
    """The flat definition list of the workspace collection, for pickers."""
    return list_definitions(request.user, workspace_id)


@router.get("/projects")
def projects(request, payload: Query[ListWorkspaceProjects]):
    return list_projects(request.user, payload)


@router.get("/projects/{project_id}")
def project(request, project_id: UUID, include_removed: bool = False):
    return project_detail(request.user, project_id, include_removed=include_removed)
