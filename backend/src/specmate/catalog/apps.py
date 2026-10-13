from django.apps import AppConfig


class CatalogConfig(AppConfig):
    name = "specmate.catalog"
    label = "catalog"

    def ready(self):
        from specmate.catalog import operations  # noqa: F401
