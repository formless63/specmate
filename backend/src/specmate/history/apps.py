from django.apps import AppConfig


class HistoryConfig(AppConfig):
    name = "specmate.history"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.history import operations  # noqa: F401
        from specmate.history.contracts import HistoryQuery

        SCHEMAS["history-list"] = HistoryQuery
