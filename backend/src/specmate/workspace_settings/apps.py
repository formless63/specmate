from django.apps import AppConfig


class WorkspaceSettingsConfig(AppConfig):
    name = "specmate.workspace_settings"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.workspace_settings import operations  # noqa: F401
        from specmate.workspace_settings.contracts import SettingsRef, UpdateSettings

        SCHEMAS.update(
            {"workspace-settings-get": SettingsRef, "workspace-settings-update": UpdateSettings}
        )
