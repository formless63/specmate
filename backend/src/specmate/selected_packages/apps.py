from django.apps import AppConfig


class SelectedPackagesConfig(AppConfig):
    name = "specmate.selected_packages"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.selected_packages import operations  # noqa: F401
        from specmate.selected_packages.contracts import Download, Selection

        SCHEMAS["selected-package-selection"] = Selection
        SCHEMAS["selected-package-download"] = Download
