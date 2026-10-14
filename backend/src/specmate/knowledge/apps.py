from django.apps import AppConfig


class KnowledgeConfig(AppConfig):
    name = "specmate.knowledge"
    label = "knowledge"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.knowledge import operations, previews, search  # noqa: F401
        from specmate.knowledge.contracts import CreateItem, LinkItem
        from specmate.knowledge.search_contracts import PreviewAttachment, SearchKnowledge

        SCHEMAS.update(
            {
                "knowledge-item": CreateItem,
                "knowledge-link": LinkItem,
                "knowledge-search": SearchKnowledge,
                "knowledge-preview": PreviewAttachment,
            }
        )
