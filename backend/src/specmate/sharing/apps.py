from django.apps import AppConfig


class SharingConfig(AppConfig):
    name = "specmate.sharing"
    label = "sharing"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.sharing import operations  # noqa: F401
        from specmate.sharing.contracts import ListShares

        SCHEMAS["share-list-query"] = ListShares
