from django.apps import AppConfig


class WireStockConfig(AppConfig):
    name = "specmate.wire_stock"
    label = "wire_stock"

    def ready(self):
        from specmate.wire_stock import operations  # noqa: F401
