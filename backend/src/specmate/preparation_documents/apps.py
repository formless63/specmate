from django.apps import AppConfig


class PreparationDocumentsConfig(AppConfig):
    name = "specmate.preparation_documents"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.preparation_documents import operations  # noqa: F401
        from specmate.preparation_documents.contracts import Configuration

        SCHEMAS["preparation-document-configuration"] = Configuration
