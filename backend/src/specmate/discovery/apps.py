from django.apps import AppConfig


class DiscoveryConfig(AppConfig):
    name = "specmate.discovery"
    label = "discovery"

    def ready(self):
        from specmate.discovery import operations  # noqa: F401
