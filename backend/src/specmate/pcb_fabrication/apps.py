from django.apps import AppConfig


class PcbFabricationConfig(AppConfig):
    name = "specmate.pcb_fabrication"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.pcb_fabrication import operations  # noqa: F401
        from specmate.pcb_fabrication.report import Report

        SCHEMAS["pcb-fabrication-report"] = Report
