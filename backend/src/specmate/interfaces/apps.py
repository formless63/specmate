from django.apps import AppConfig


class InterfacesConfig(AppConfig):
    name = "specmate.interfaces"

    def ready(self):
        from specmate.interfaces import operations  # noqa: F401
