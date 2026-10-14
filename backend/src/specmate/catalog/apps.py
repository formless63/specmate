from django.apps import AppConfig


class CatalogConfig(AppConfig):
    name = "specmate.catalog"
    label = "catalog"

    def ready(self):
        from specmate.catalog import (
            discovery,  # noqa: F401
            operations,  # noqa: F401
        )
        from specmate.catalog.contracts import (
            LotResult,
            RepresentationResult,
            SourceIdentifierResult,
            VariantResult,
        )
        from specmate.catalog.discovery import (
            RevisionImpact,
            RevisionLabels,
            SearchCatalog,
            WhereUsed,
        )
        from specmate.contracts import SCHEMAS

        SCHEMAS.update(
            {
                "catalog-lot": LotResult,
                "catalog-representation": RepresentationResult,
                "catalog-source-identifier": SourceIdentifierResult,
                "catalog-variant": VariantResult,
                "catalog-search": SearchCatalog,
                "catalog-where-used": WhereUsed,
                "catalog-revision-impact": RevisionImpact,
                "catalog-revision-labels": RevisionLabels,
            }
        )
