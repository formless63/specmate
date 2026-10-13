from concurrent.futures import ThreadPoolExecutor
from io import StringIO
from threading import Barrier

import psycopg
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, connections

from specmate.access.models import Installation
from specmate.operations import startup

pytestmark = pytest.mark.django_db(transaction=True)


def test_bootstrap_is_idempotent_and_readiness_checks_bootstrap():
    assert not startup.schema_ready()
    call_command("startup", stdout=StringIO())
    identity = Installation.objects.get().installation_id
    call_command("startup", stdout=StringIO())
    assert Installation.objects.get().installation_id == identity
    call_command("startup", check=True, timeout=0, stdout=StringIO())


def test_jobs_check_cannot_initialize_a_database():
    with pytest.raises(CommandError, match="Timed out"):
        call_command("startup", check=True, timeout=0, stdout=StringIO())
    assert not Installation.objects.exists()


def test_initializer_lock_has_bounded_wait():
    with psycopg.connect(**connection.get_connection_params(), autocommit=True) as other:
        other.execute("SELECT pg_advisory_lock(%s)", [startup.STARTUP_LOCK])
        with pytest.raises(CommandError, match="Timed out"):
            call_command("startup", timeout=0, stdout=StringIO())
    assert not Installation.objects.exists()


def test_migration_failure_propagates_and_releases_lock(monkeypatch):
    def fail_migration(*args, **kwargs):
        raise RuntimeError("synthetic migration failure")

    monkeypatch.setattr(startup, "call_command", fail_migration)
    with pytest.raises(RuntimeError, match="synthetic migration failure"):
        call_command("startup", stdout=StringIO())
    assert not startup.schema_ready()
    with psycopg.connect(**connection.get_connection_params(), autocommit=True) as other:
        assert other.execute("SELECT pg_try_advisory_lock(%s)", [startup.STARTUP_LOCK]).fetchone()[
            0
        ]


def test_parallel_initializers_create_one_installation():
    barrier = Barrier(2)

    def initialize():
        try:
            barrier.wait(timeout=5)
            call_command("startup", stdout=StringIO())
            return Installation.objects.get().installation_id
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        identities = list(pool.map(lambda _: initialize(), range(2)))
    assert identities[0] == identities[1]
    assert Installation.objects.count() == 1
