from django.apps import AppConfig


class DesignConfig(AppConfig):
    name = "specmate.design"
    label = "design"

    def ready(self):
        from specmate.design import operations  # noqa: F401  (registers operations)
