from django.apps import AppConfig


class PcbConfig(AppConfig):
    name = "specmate.pcb"
    label = "pcb"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.pcb import authority, firmware, operations  # noqa: F401
        from specmate.pcb.population import Population
        from specmate.pcb.report import Report

        SCHEMAS["pcb-report"] = Report
        SCHEMAS["pcb-population"] = Population
        SCHEMAS["firmware"] = firmware.Firmware
