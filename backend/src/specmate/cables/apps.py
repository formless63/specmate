from django.apps import AppConfig


class CablesConfig(AppConfig):
    name = "specmate.cables"

    def ready(self):
        from specmate.cables import operations  # noqa: F401
        from specmate.cables.connections import ConnectionsQuery
        from specmate.cables.contracts import Cable
        from specmate.contracts import SCHEMAS

        SCHEMAS["cable"] = Cable
        SCHEMAS["cable-connections"] = ConnectionsQuery
