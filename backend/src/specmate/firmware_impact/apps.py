from django.apps import AppConfig


class FirmwareImpactConfig(AppConfig):
    name = "specmate.firmware_impact"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.firmware_impact import operations  # noqa: F401
        from specmate.firmware_impact.contracts import CompareImpact

        SCHEMAS["firmware-impact-compare"] = CompareImpact
