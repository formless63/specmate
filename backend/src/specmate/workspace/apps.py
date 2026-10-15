from django.apps import AppConfig


class WorkspaceConfig(AppConfig):
    name = "specmate.workspace"
    label = "workspace"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.workspace import gallery, search  # noqa: F401
        from specmate.workspace.contracts import (
            LibraryPage,
            ListLibrary,
            ListWorkspaceProjects,
            ProjectDetail,
            WorkspaceProjectPage,
        )
        from specmate.workspace.gallery_contracts import (
            LibraryHome,
            LibraryPreviews,
            LibrarySearch,
            ReadLibraryHome,
            ReadLibraryPreviews,
            SearchLibrary,
        )

        SCHEMAS.update(
            {
                "workspace-library": ListLibrary,
                "workspace-library-page": LibraryPage,
                "workspace-projects": ListWorkspaceProjects,
                "workspace-project-page": WorkspaceProjectPage,
                "workspace-project-detail": ProjectDetail,
                "library-home-request": ReadLibraryHome,
                "library-home": LibraryHome,
                "library-previews-request": ReadLibraryPreviews,
                "library-previews": LibraryPreviews,
                "library-search-request": SearchLibrary,
                "library-search": LibrarySearch,
            }
        )
