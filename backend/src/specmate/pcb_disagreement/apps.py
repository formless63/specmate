from django.apps import AppConfig


class PcbDisagreementConfig(AppConfig):
    name = "specmate.pcb_disagreement"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.pcb_disagreement import native_operations, operations  # noqa: F401
        from specmate.pcb_disagreement.contracts import Assertion, Comparison

        SCHEMAS["pcb_assertion"] = Assertion
        SCHEMAS["pcb_comparison"] = Comparison
