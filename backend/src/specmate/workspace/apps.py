from django.apps import AppConfig


class WorkspaceConfig(AppConfig):
    name = "specmate.workspace"
    label = "workspace"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.workspace.contracts import (
            LibraryPage,
            ListLibrary,
            ListWorkspaceProjects,
            ProjectDetail,
            WorkspaceProjectPage,
        )

        SCHEMAS.update(
            {
                "workspace-library": ListLibrary,
                "workspace-library-page": LibraryPage,
                "workspace-projects": ListWorkspaceProjects,
                "workspace-project-page": WorkspaceProjectPage,
                "workspace-project-detail": ProjectDetail,
            }
        )
