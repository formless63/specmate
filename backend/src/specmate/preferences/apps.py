from django.apps import AppConfig


class PreferencesConfig(AppConfig):
    name = "specmate.preferences"
    label = "preferences"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.preferences import operations  # noqa: F401
        from specmate.preferences.contracts import SetPreferences

        SCHEMAS.update({"preferences-set": SetPreferences})
