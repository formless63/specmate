"""One fresh read serves HTTP and the shared operation entry point."""

from specmate.access.permissions import Perm
from specmate.history.contracts import HistoryQuery
from specmate.history.queries import list_history
from specmate.operations import Context, operation


@operation(
    "history.list",
    HistoryQuery,
    summary="Read retained keyed engineering receipts, frozen revisions or current drafts.",
    access=Perm.WORKSPACE_READ,
    supports_idempotency=False,
)
def history_list(ctx: Context, payload: HistoryQuery):
    return list_history(ctx.user, payload)
