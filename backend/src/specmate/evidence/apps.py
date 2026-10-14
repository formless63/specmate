from django.apps import AppConfig


class EvidenceConfig(AppConfig):
    name = "specmate.evidence"
    label = "evidence"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.evidence import operations  # noqa: F401
        from specmate.evidence.contracts import (
            EvidenceList,
            ListEvidence,
            ReadRecordedResult,
            RecordedResult,
            RecordFirmwareImpact,
            RecordInterfaceAssessment,
            Taxonomy,
        )

        SCHEMAS.update(
            {
                "evidence-list-query": ListEvidence,
                "evidence-list": EvidenceList,
                "evidence-taxonomy": Taxonomy,
                "evidence-record-interface-assessment": RecordInterfaceAssessment,
                "evidence-record-firmware-impact": RecordFirmwareImpact,
                "evidence-recorded-read": ReadRecordedResult,
                "evidence-recorded-result": RecordedResult,
            }
        )
