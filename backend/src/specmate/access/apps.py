from django.apps import AppConfig


class AccessConfig(AppConfig):
    name = "specmate.access"
    label = "access"

    def ready(self):
        from specmate.access import (  # noqa: F401  (registers operations)
            operations,
            projects,
            session,
        )
