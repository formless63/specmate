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
        from specmate.workspace.design_contracts import DesignPage, ListDesigns
        from specmate.workspace.gallery_contracts import (
            LibraryHome,
            LibraryPreviews,
            LibrarySearch,
            ReadLibraryHome,
            ReadLibraryPreviews,
            SearchLibrary,
        )
        from specmate.workspace.table_contracts import LibraryTablePage, ListLibraryTable

        SCHEMAS.update(
            {
                "workspace-designs": ListDesigns,
                "workspace-designs-page": DesignPage,
                "workspace-library-table": ListLibraryTable,
                "workspace-library-table-page": LibraryTablePage,
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
