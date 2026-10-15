from django.apps import AppConfig


class FactsConfig(AppConfig):
    name = "specmate.facts"
    label = "facts"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.facts import operations  # noqa: F401
        from specmate.facts.contracts import FactContent, RegisterSubject, ResolveSubject

        SCHEMAS.update(
            {
                "fact-assertion": FactContent,
                "fact-subject": RegisterSubject,
                "fact-resolve-subject": ResolveSubject,
            }
        )
