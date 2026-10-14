from django.apps import AppConfig


class SourcingConfig(AppConfig):
    name = "specmate.sourcing"
    label = "sourcing"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.sourcing import operations  # noqa: F401
        from specmate.sourcing.contracts import OfferResult, RecordOffer, SourcingReadRequest

        SCHEMAS.update(
            {
                "sourcing-offer": OfferResult,
                "sourcing-record-offer": RecordOffer,
                "sourcing-report-request": SourcingReadRequest,
            }
        )
