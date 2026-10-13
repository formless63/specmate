from django.apps import AppConfig


class EndPreparationConfig(AppConfig):
    name = "specmate.end_preparation"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.end_preparation import operations  # noqa: F401
        from specmate.end_preparation.contracts import EndPreparationProfile

        SCHEMAS["end_preparation_profile"] = EndPreparationProfile
