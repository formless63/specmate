from django.apps import AppConfig


class AssembliesConfig(AppConfig):
    name = "specmate.assemblies"
    label = "assemblies"

    def ready(self):
        from specmate.assemblies import operations  # noqa: F401
