from django.apps import AppConfig


class HarnessesConfig(AppConfig):
    name = "specmate.harnesses"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.harnesses import operations  # noqa: F401
        from specmate.harnesses.contracts import Harness

        SCHEMAS["harness"] = Harness
