from django.apps import AppConfig


class BomConfig(AppConfig):
    name = "specmate.bom"

    def ready(self):
        from specmate.bom import operations  # noqa: F401
        from specmate.bom.contracts import BomPlan, ReadBom
        from specmate.contracts import SCHEMAS

        SCHEMAS.update({"bom-plan": BomPlan, "bom-read": ReadBom})
