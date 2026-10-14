"""Admission guards used by build operations. They read only; they never change state."""

from django.db import connection

from specmate.diagnostics.models import WorkControl
from specmate.operations import OperationError


class InstallationNotAccepting(OperationError):
    code = "installation_not_accepting_work"
    http_status = 503


def _mode(*, lock: bool) -> str:
    table = connection.ops.quote_name(WorkControl._meta.db_table)
    # A shared row lock makes admission and a concurrent safe stop serialize: a request
    # either commits before the stop's sweep sees it or observes the stop.
    suffix = " FOR SHARE" if lock else ""
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT mode FROM {table} WHERE singleton{suffix}")  # noqa: S608
        row = cursor.fetchone()
    return row[0] if row else WorkControl.Mode.RUNNING


def require_accepting_work() -> None:
    """Refuse a new request while the installation is draining or interrupting."""
    mode = _mode(lock=True)
    if mode != WorkControl.Mode.RUNNING:
        raise InstallationNotAccepting(
            "This installation is stopping and is not accepting new work.",
            details={"mode": mode},
        )


def leasing_allowed() -> bool:
    """Draining lets accepted work finish; interrupting hands out no new leases."""
    return _mode(lock=False) != WorkControl.Mode.INTERRUPTING
