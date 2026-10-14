from django.apps import AppConfig


class ConfigurationsConfig(AppConfig):
    name = "specmate.configurations"
    label = "configurations"

    def ready(self):
        from specmate.configurations import operations  # noqa: F401
        from specmate.configurations.contracts import (
            CaptureResolution,
            ConfigurationContent,
            OptionSetContent,
            ResolveConfiguration,
            ResolvedRef,
        )
        from specmate.contracts import SCHEMAS

        SCHEMAS.update(
            {
                "option-set-content": OptionSetContent,
                "configuration-content": ConfigurationContent,
                "configuration-resolve": ResolveConfiguration,
                "configuration-capture": CaptureResolution,
                "configuration-resolved-ref": ResolvedRef,
            }
        )
