from django.apps import AppConfig


class DiagnosticsConfig(AppConfig):
    name = "specmate.diagnostics"
    label = "diagnostics"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.diagnostics import operations  # noqa: F401
        from specmate.diagnostics.operations import SafeStop

        SCHEMAS.update({"installation-safe-stop": SafeStop})
