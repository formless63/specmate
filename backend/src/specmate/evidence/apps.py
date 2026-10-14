from django.apps import AppConfig


class EvidenceConfig(AppConfig):
    name = "specmate.evidence"
    label = "evidence"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.evidence import operations  # noqa: F401
        from specmate.evidence.contracts import EvidenceList, ListEvidence, Taxonomy

        SCHEMAS.update(
            {
                "evidence-list-query": ListEvidence,
                "evidence-list": EvidenceList,
                "evidence-taxonomy": Taxonomy,
            }
        )
