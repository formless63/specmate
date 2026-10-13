from django.apps import AppConfig


class InventoryConfig(AppConfig):
    name = "specmate.inventory"
    label = "inventory"

    def ready(self):
        from specmate.inventory import operations  # noqa: F401
