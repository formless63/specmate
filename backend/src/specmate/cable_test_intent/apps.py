from django.apps import AppConfig


class CableTestIntentConfig(AppConfig):
    name = "specmate.cable_test_intent"

    def ready(self):
        from specmate.cable_test_intent import operations  # noqa: F401
        from specmate.cable_test_intent.contracts import TestPlan
        from specmate.contracts import SCHEMAS

        SCHEMAS["cable-test-plan"] = TestPlan
