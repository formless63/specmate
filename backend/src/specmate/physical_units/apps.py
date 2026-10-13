from django.apps import AppConfig


class PhysicalUnitsConfig(AppConfig):
    name = "specmate.physical_units"
    label = "physical_units"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.physical_units import operations  # noqa: F401
        from specmate.physical_units.contracts import (
            LinkWorkUnit,
            PhysicalUnitResult,
            RegisterPhysicalUnit,
            WorkUnitLinkResult,
        )

        SCHEMAS.update(
            {
                "physical-unit": PhysicalUnitResult,
                "physical-work-unit-link": WorkUnitLinkResult,
                "physical-unit-register": RegisterPhysicalUnit,
                "physical-work-unit-link-command": LinkWorkUnit,
            }
        )
