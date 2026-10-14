"""Test helpers for workspace-scoped payloads."""

from specmate.access.models import Project


def workspace_of(scope_id):
    """The workspace (str) that holds a project: collection items are created there.

    Helpers shared across tests receive either a project id or a workspace id. Any id that
    names no project (a workspace id, or a deliberately unknown id) is returned unchanged.
    """
    workspace_id = (
        Project.objects.filter(id=scope_id).values_list("workspace_id", flat=True).first()
    )
    return str(workspace_id if workspace_id is not None else scope_id)
