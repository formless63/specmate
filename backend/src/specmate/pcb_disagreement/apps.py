from django.apps import AppConfig


class PcbDisagreementConfig(AppConfig):
    name = "specmate.pcb_disagreement"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.pcb_disagreement import native_operations, operations  # noqa: F401
        from specmate.pcb_disagreement.contracts import Assertion, Comparison
        from specmate.pcb_disagreement.native_operations import (
            AcceptNative,
            ReadNative,
            RequestNative,
        )
        from specmate.pcb_disagreement.native_report import NativeReport

        SCHEMAS.update(
            {
                "pcb-native-report": NativeReport,
                "pcb-native-request": RequestNative,
                "pcb-native-accept": AcceptNative,
                "pcb-native-read": ReadNative,
            }
        )
        SCHEMAS["pcb_assertion"] = Assertion
        SCHEMAS["pcb_comparison"] = Comparison
