from django.apps import AppConfig


class BuildsConfig(AppConfig):
    name = "specmate.builds"
    label = "builds"

    def ready(self):
        from specmate.builds import (
            operations,  # noqa: F401
            recovery,  # noqa: F401
        )
