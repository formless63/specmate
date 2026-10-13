from specmate.copper.contracts import ReadGraph
from specmate.copper.queries import inspect_graph
from specmate.operations import Context, operation


@operation(
    "copper.graph",
    ReadGraph,
    summary="Inspect exact occurrence-scoped copper declarations and net boundaries.",
    supports_idempotency=False,
)
def graph(ctx: Context, payload: ReadGraph):
    return inspect_graph(ctx.user, payload)
