from django.apps import AppConfig


class MaterialAccountingConfig(AppConfig):
    name = "specmate.material_accounting"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.material_accounting import operations  # noqa: F401
        from specmate.material_accounting.contracts import MaterialPlan

        SCHEMAS["material_plan"] = MaterialPlan
