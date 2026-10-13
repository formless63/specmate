from django.apps import AppConfig


class PreparationConfig(AppConfig):
    name = "specmate.preparation"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.preparation import operations  # noqa: F401
        from specmate.preparation.contracts import PreparationProfile

        SCHEMAS["preparation_profile"] = PreparationProfile
