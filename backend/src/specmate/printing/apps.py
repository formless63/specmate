from django.apps import AppConfig


class PrintingConfig(AppConfig):
    name = "specmate.printing"
    label = "printing"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.printing import operations, resin  # noqa: F401
        from specmate.printing.contracts import (
            OrcaSliceReport,
            PrintPreparation,
            PrintProfile,
            ResinInspectionReport,
            SliceReport,
        )

        SCHEMAS["print-profile"] = PrintProfile
        SCHEMAS["print-preparation"] = PrintPreparation
        SCHEMAS["print-slice-report"] = SliceReport
        SCHEMAS["print-slice-report-orcaslicer"] = OrcaSliceReport
        SCHEMAS["print-resin-inspection-report"] = ResinInspectionReport
