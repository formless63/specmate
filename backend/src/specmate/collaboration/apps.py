from django.apps import AppConfig


class CollaborationConfig(AppConfig):
    name = "specmate.collaboration"
    label = "collaboration"

    def ready(self):
        from specmate.collaboration import operations  # noqa: F401
        from specmate.collaboration.contracts import CompareRevisions, CreateReview, RespondReview
        from specmate.contracts import SCHEMAS

        SCHEMAS.update(
            {
                "collaboration-comparison": CompareRevisions,
                "collaboration-review": CreateReview,
                "collaboration-response": RespondReview,
            }
        )
