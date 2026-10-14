"""Test helpers for workspace-scoped payloads."""

from specmate.access.models import Project


def workspace_of(project_id):
    """The workspace (str) that holds a project: collection items are created there."""
    return str(Project.objects.values_list("workspace_id", flat=True).get(id=project_id))
