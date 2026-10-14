from django.apps import AppConfig


class ExportPackagesConfig(AppConfig):
    name = "specmate.export_packages"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.export_packages import operations  # noqa: F401
        from specmate.export_packages.contracts import Download, ExportRequest

        SCHEMAS["export-package-request"] = ExportRequest
        SCHEMAS["export-package-download"] = Download
