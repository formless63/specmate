from django.apps import AppConfig


class AssembliesConfig(AppConfig):
    name = "specmate.assemblies"
    label = "assemblies"

    def ready(self):
        from specmate.assemblies import operations  # noqa: F401
        from specmate.assemblies.contracts import AssemblyContent, ResolveOccurrence
        from specmate.assemblies.placement import PlacementInputs
        from specmate.contracts import SCHEMAS

        SCHEMAS.update({"assembly": AssemblyContent, "occurrence-address": ResolveOccurrence})
        SCHEMAS["assembly-placement-inputs"] = PlacementInputs
