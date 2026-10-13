from django.apps import AppConfig


class PassivePassagesConfig(AppConfig):
    name = "specmate.passive_passages"
    label = "passive_passages"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.passive_passages import operations  # noqa: F401
        from specmate.passive_passages.contracts import (
            CaptureModel,
            CreateModel,
            InterpretModel,
            PassageModel,
            ReviewModel,
            UpdateModel,
        )

        SCHEMAS.update(
            {
                "passage-model": PassageModel,
                "passage-create": CreateModel,
                "passage-update": UpdateModel,
                "passage-capture": CaptureModel,
                "passage-review": ReviewModel,
                "passage-interpret": InterpretModel,
            }
        )
