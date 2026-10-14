from django.apps import AppConfig


class ConfigurationsConfig(AppConfig):
    name = "specmate.configurations"
    label = "configurations"

    def ready(self):
        from specmate.configurations import adoption, operations  # noqa: F401
        from specmate.configurations.contracts import (
            AdoptionRef,
            AdoptResolution,
            AuthoringContext,
            CaptureResolution,
            ConfigurationContent,
            OptionSetContent,
            ResolveConfiguration,
            ResolvedRef,
            ReviewAdoption,
        )
        from specmate.contracts import SCHEMAS

        SCHEMAS.update(
            {
                "option-set-content": OptionSetContent,
                "configuration-content": ConfigurationContent,
                "configuration-resolve": ResolveConfiguration,
                "configuration-capture": CaptureResolution,
                "configuration-resolved-ref": ResolvedRef,
                "configuration-authoring-context": AuthoringContext,
                "configuration-review-adoption": ReviewAdoption,
                "configuration-adopt": AdoptResolution,
                "configuration-adoption-ref": AdoptionRef,
            }
        )
