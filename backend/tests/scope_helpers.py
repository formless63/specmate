"""Test helpers for workspace-scoped payloads."""

from specmate.access.models import Project, Workspace


def workspace_of(scope_id):
    """The workspace (str) that holds a project: collection items are created there.

    Helpers shared across phases receive either a project id or a workspace id; a workspace id
    is returned unchanged.
    """
    if Workspace.objects.filter(id=scope_id).exists():
        return str(scope_id)
    return str(Project.objects.values_list("workspace_id", flat=True).get(id=scope_id))
