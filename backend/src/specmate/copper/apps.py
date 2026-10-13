from django.apps import AppConfig


class CopperConfig(AppConfig):
    name = "specmate.copper"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.copper import operations  # noqa: F401
        from specmate.copper.contracts import Graph, ReadGraph

        SCHEMAS["copper_graph"] = Graph
        SCHEMAS["copper_graph_query"] = ReadGraph
