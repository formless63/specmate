from django.apps import AppConfig


class PrintingConfig(AppConfig):
    name = "specmate.printing"
    label = "printing"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.printing import operations  # noqa: F401
        from specmate.printing.contracts import PrintPreparation, PrintProfile, SliceReport

        SCHEMAS["print-profile"] = PrintProfile
        SCHEMAS["print-preparation"] = PrintPreparation
        SCHEMAS["print-slice-report"] = SliceReport
