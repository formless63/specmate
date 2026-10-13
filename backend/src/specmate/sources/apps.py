from django.apps import AppConfig


class SourcesConfig(AppConfig):
    name = "specmate.sources"
    label = "sources"

    def ready(self):
        from specmate.sources import (  # noqa: F401  (registers operations)
            archive_operations,
            operations,
        )
