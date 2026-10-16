from django.apps import AppConfig


class CablesConfig(AppConfig):
    name = "specmate.cables"

    def ready(self):
        from specmate.cables import operations  # noqa: F401
        from specmate.cables.connections import ConnectionsQuery
        from specmate.cables.contracts import Cable, SectionCable
        from specmate.contracts import SCHEMAS

        SCHEMAS["cable"] = Cable
        SCHEMAS["section-cable"] = SectionCable
        SCHEMAS["cable-connections"] = ConnectionsQuery
