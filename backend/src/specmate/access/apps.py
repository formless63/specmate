from django.apps import AppConfig


class AccessConfig(AppConfig):
    name = "specmate.access"
    label = "access"

    def ready(self):
        from specmate.access import operations  # noqa: F401  (registers operations)
