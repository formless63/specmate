from django.apps import AppConfig


class MechanicalSourcesConfig(AppConfig):
    name = "specmate.mechanical_sources"
    label = "mechanical_sources"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.mechanical_sources import operations  # noqa: F401
        from specmate.mechanical_sources.contracts import MechanicalSource

        SCHEMAS["mechanical_source"] = MechanicalSource
