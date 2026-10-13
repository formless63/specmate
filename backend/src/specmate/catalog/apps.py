from django.apps import AppConfig


class CatalogConfig(AppConfig):
    name = "specmate.catalog"
    label = "catalog"

    def ready(self):
        from specmate.catalog import operations  # noqa: F401
        from specmate.catalog.contracts import LotResult, RepresentationResult, VariantResult
        from specmate.contracts import SCHEMAS

        SCHEMAS.update(
            {
                "catalog-lot": LotResult,
                "catalog-representation": RepresentationResult,
                "catalog-variant": VariantResult,
            }
        )
