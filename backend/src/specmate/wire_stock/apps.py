from django.apps import AppConfig


class WireStockConfig(AppConfig):
    name = "specmate.wire_stock"
    label = "wire_stock"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.wire_stock import operations  # noqa: F401
        from specmate.wire_stock.schemas import StockSpecification

        SCHEMAS.update(
            {
                "wire-stock": StockSpecification,
            }
        )
