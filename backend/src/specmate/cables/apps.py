from django.apps import AppConfig


class CablesConfig(AppConfig):
    name = "specmate.cables"

    def ready(self):
        from specmate.cables import operations  # noqa: F401
        from specmate.cables.contracts import Cable
        from specmate.contracts import SCHEMAS

        SCHEMAS["cable"] = Cable
