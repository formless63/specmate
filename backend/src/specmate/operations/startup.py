"""Checked-in schema initialization and read-only readiness for app and trusted jobs."""

import time

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, OperationalError, connection
from django.db.migrations.exceptions import InconsistentMigrationHistory
from django.db.migrations.executor import MigrationExecutor

from specmate.access.models import Installation

# A stable, application-specific session lock, held across Django's migration transactions.
STARTUP_LOCK = 0x535045434D415445


def schema_ready() -> bool:
    """A reachable database alone is insufficient for admitting requests or jobs."""
    try:
        executor = MigrationExecutor(connection)
        executor.loader.check_consistent_history(connection)
        return not executor.migration_plan(executor.loader.graph.leaf_nodes()) and (
            Installation.objects.filter(singleton=True).exists()
        )
    except (DatabaseError, InconsistentMigrationHistory):
        connection.close()
        return False


def initialize(*, timeout: float, check_only: bool = False, stdout=None) -> None:
    deadline = time.monotonic() + timeout
    while True:
        if check_only:
            if schema_ready():
                return
        else:
            try:
                connection.ensure_connection()
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_try_advisory_lock(%s)", [STARTUP_LOCK])
                    locked = cursor.fetchone()[0]
            except OperationalError:
                connection.close()
                locked = False
            if locked:
                try:
                    # Migrations fail visibly and are never generated or repaired here.
                    call_command("migrate", interactive=False, stdout=stdout)
                    Installation.objects.get_or_create(singleton=True)
                    if not schema_ready():
                        raise CommandError("Application schema is not ready after migrations.")
                    return
                finally:
                    # Closing a broken connection also releases its session lock.
                    if connection.connection is not None:
                        with connection.cursor() as cursor:
                            cursor.execute("SELECT pg_advisory_unlock(%s)", [STARTUP_LOCK])
        if time.monotonic() >= deadline:
            raise CommandError("Timed out waiting for application schema readiness/initializer.")
        time.sleep(min(1, max(0, deadline - time.monotonic())))
