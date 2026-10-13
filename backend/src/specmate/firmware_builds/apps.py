from django.apps import AppConfig


class FirmwareBuildsConfig(AppConfig):
    name = "specmate.firmware_builds"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.firmware_builds import operations  # noqa: F401
        from specmate.firmware_builds.contracts import CompileReport

        SCHEMAS["firmware-compile-report"] = CompileReport
