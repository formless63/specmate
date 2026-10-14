from django.apps import AppConfig


class IntegrationsConfig(AppConfig):
    name = "specmate.integrations"
    label = "integrations"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.integrations import operations  # noqa: F401
        from specmate.integrations.contracts import (
            CreateIntegration,
            ExportNeeds,
            ExportResult,
            ImportObservations,
            ImportResult,
            IntegrationResult,
            UpdateIntegration,
        )

        SCHEMAS.update(
            {
                "integration-create": CreateIntegration,
                "integration-update": UpdateIntegration,
                "integration-state": IntegrationResult,
                "integration-import": ImportObservations,
                "integration-import-result": ImportResult,
                "integration-export-needs": ExportNeeds,
                "integration-export-result": ExportResult,
            }
        )
