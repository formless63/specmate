from django.apps import AppConfig


class WireStockConfig(AppConfig):
    name = "specmate.wire_stock"
    label = "wire_stock"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.wire_stock import operations
        from specmate.wire_stock.recipes import Constituent, StockRecipe
        from specmate.wire_stock.schemas import StockSpecification

        SCHEMAS.update(
            {
                "wire-stock": StockSpecification,
                "stock-constituent": Constituent,
                "stock-recipe": StockRecipe,
                "stock-compile-recipe": operations.CompileRecipe,
            }
        )
