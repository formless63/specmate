from django.apps import AppConfig


class RevisionUpgradesConfig(AppConfig):
    name = "specmate.revision_upgrades"
    label = "revision_upgrades"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.revision_upgrades import operations  # noqa: F401
        from specmate.revision_upgrades.contracts import (
            ApplyUpgrade,
            ProposeUpgrade,
            ReadConsumers,
            ReadUpgrade,
            ReviewUpgrade,
        )

        SCHEMAS.update(
            {
                "upgrade-propose": ProposeUpgrade,
                "upgrade-review": ReviewUpgrade,
                "upgrade-apply": ApplyUpgrade,
                "upgrade-read": ReadUpgrade,
                "upgrade-consumers": ReadConsumers,
            }
        )
