from django.apps import AppConfig


class WorkshopProfilesConfig(AppConfig):
    name = "specmate.workshop_profiles"
    label = "workshop_profiles"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.workshop_profiles import operations  # noqa: F401
        from specmate.workshop_profiles.schemas import WorkshopProfile

        SCHEMAS["workshop-profile"] = WorkshopProfile
