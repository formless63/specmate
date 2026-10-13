from django.apps import AppConfig


class FirmwareOccurrencesConfig(AppConfig):
    name = "specmate.firmware_occurrences"
    label = "firmware_occurrences"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.firmware_occurrences import operations  # noqa: F401
        from specmate.firmware_occurrences.contracts import (
            AdoptOccurrence,
            InspectOccurrences,
            ReadAdoption,
            ReviewOccurrence,
        )

        SCHEMAS.update(
            {
                "firmware-occurrence-inspect": InspectOccurrences,
                "firmware-occurrence-review": ReviewOccurrence,
                "firmware-occurrence-adopt": AdoptOccurrence,
                "firmware-occurrence-read-adoption": ReadAdoption,
            }
        )
