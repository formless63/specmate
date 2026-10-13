from django.apps import AppConfig


class CatalogMatchingConfig(AppConfig):
    name = "specmate.catalog_matching"
    label = "catalog_matching"

    def ready(self):
        from specmate.catalog_matching import (
            operations,  # noqa: F401
            suppliers,  # noqa: F401
        )
        from specmate.catalog_matching.contracts import (
            CandidateResult,
            ProposeMatch,
            ReviewMatch,
            SuggestSupplierMatches,
            SupplierSuggestions,
        )
        from specmate.contracts import SCHEMAS

        SCHEMAS.update(
            {
                "catalog-match-candidate": CandidateResult,
                "catalog-propose-match": ProposeMatch,
                "catalog-review-match": ReviewMatch,
                "catalog-suggest-supplier-matches": SuggestSupplierMatches,
                "catalog-supplier-suggestions": SupplierSuggestions,
            }
        )
