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
        from specmate.parts import membership, records  # noqa: F401
        from specmate.parts.contracts import CatalogRecord, Kit, Part, ReadKits, ReadRecord

        SCHEMAS.update(
            {
                "catalog-record": ReadRecord,
                "catalog-record-result": CatalogRecord,
                "catalog-kits-for-revision": ReadKits,
                "catalog-part": Part,
                "catalog-kit": Kit,
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
