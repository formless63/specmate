from django.apps import AppConfig


class InterfacesConfig(AppConfig):
    name = "specmate.interfaces"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.interfaces import operations  # noqa: F401
        from specmate.interfaces.assessment_contracts import AssessmentResult, InterfaceAssessment
        from specmate.interfaces.board_contracts import Board
        from specmate.interfaces.contracts import (
            ConnectorBody,
            InterfaceMap,
            Pinout,
            Port,
            TraceInterface,
        )
        from specmate.interfaces.convention_contracts import ConductorConvention
        from specmate.interfaces.signal_contracts import SignalSet

        SCHEMAS.update(
            {
                "connector-body": ConnectorBody,
                "pinout": Pinout,
                "interface-map": InterfaceMap,
                "interface-trace": TraceInterface,
                "interface-assessment": InterfaceAssessment,
                "interface-assessment-result": AssessmentResult,
                "signal-set": SignalSet,
                "port": Port,
                "board": Board,
                "conductor-convention": ConductorConvention,
            }
        )
