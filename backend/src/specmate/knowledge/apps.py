from django.apps import AppConfig


class KnowledgeConfig(AppConfig):
    name = "specmate.knowledge"
    label = "knowledge"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.knowledge import operations  # noqa: F401
        from specmate.knowledge.contracts import CreateItem, LinkItem

        SCHEMAS.update({"knowledge-item": CreateItem, "knowledge-link": LinkItem})
