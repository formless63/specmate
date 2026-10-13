"""Real PostgreSQL races for draft state, frozen evidence and keyed transactions."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

import pytest
from django.db import connection, connections

from specmate.design import operations as design_operations
from specmate.design.models import Definition, Draft, Revision, Snapshot
from specmate.jobs.adapter import run_operation
from specmate.operations import Conflict, registry
from specmate.operations.models import IdempotencyRecord

from .conftest import op

pytestmark = pytest.mark.django_db(transaction=True)


def race(action):
    start = Barrier(2)

    def worker(index):
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET lock_timeout = '5s'")
                cursor.execute("SET statement_timeout = '10s'")
            start.wait(timeout=5)
            try:
                return action(index)
            except Conflict as error:
                return error
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(worker, index) for index in range(2)]
        return [future.result(timeout=15) for future in pending]


def concurrent_definition(users, project):
    return op(
        users["owner"],
        "definition.create",
        {"project_id": project, "kind": "part", "name": "Concurrent synthetic part"},
    )


def rendezvous_draft_lock(monkeypatch):
    ready = Barrier(2)
    original = design_operations.scoped_draft

    def resolve(*args, **kwargs):
        # Both requests reach the shared operation before either acquires its row lock.
        ready.wait(timeout=5)
        return original(*args, **kwargs)

    monkeypatch.setattr(design_operations, "scoped_draft", resolve)


def test_parallel_edits_preserve_one_winner_and_report_its_current_state(
    users, project, monkeypatch
):
    definition = concurrent_definition(users, project)
    rendezvous_draft_lock(monkeypatch)
    results = race(
        lambda index: run_operation(
            on_behalf_of=users[("owner", "editor")[index]].pk,
            operation="draft.update",
            payload={"draft_id": definition["draft_id"], "changes": {"writer": index}},
            expected_state=definition["state"],
            request_id=f"parallel-edit-{index}",
        )
    )
    winners = [item for item in results if not isinstance(item, Conflict)]
    conflicts = [item for item in results if isinstance(item, Conflict)]
    assert len(winners) == len(conflicts) == 1
    saved = Draft.objects.get(id=definition["draft_id"])
    assert saved.version == 2
    assert saved.content == winners[0].result["content"]
    assert conflicts[0].details["current"]["state"] == saved.state_token
    assert conflicts[0].details["current"]["content"] == saved.content


def test_parallel_freezes_leave_one_revision_and_no_orphan_snapshot(users, project, monkeypatch):
    definition = concurrent_definition(users, project)
    rendezvous_draft_lock(monkeypatch)
    results = race(
        lambda index: run_operation(
            on_behalf_of=users["owner"].pk,
            operation="draft.freeze",
            payload={"draft_id": definition["draft_id"]},
            expected_state=definition["state"],
            request_id=f"parallel-freeze-{index}",
        )
    )
    winners = [item for item in results if not isinstance(item, Conflict)]
    assert len(winners) == 1
    assert sum(isinstance(item, Conflict) for item in results) == 1
    assert Revision.objects.count() == Snapshot.objects.count() == 1
    revision = Revision.objects.get()
    assert str(revision.id) == winners[0].result["revision_id"]
    assert revision.number == 1
    saved = Draft.objects.get(id=definition["draft_id"])
    assert saved.version == 2 and saved.base_revision_id == revision.id


def test_parallel_keyed_creates_roll_back_duplicate_and_retry_the_exact_winner(
    users, project, monkeypatch
):
    payload = {"project_id": project, "kind": "part", "name": "Keyed synthetic part"}
    original = registry["definition.create"]
    ready = Barrier(2)

    def create_after_both_read_missing_key(ctx, parsed):
        ready.wait(timeout=5)
        return original.handler(ctx, parsed)

    with monkeypatch.context() as patch:
        patch.setitem(
            registry,
            "definition.create",
            replace(original, handler=create_after_both_read_missing_key),
        )
        results = race(
            lambda index: run_operation(
                on_behalf_of=users["owner"].pk,
                operation="definition.create",
                payload=payload,
                idempotency_key="concurrent-create",
                request_id=f"parallel-create-{index}",
            )
        )
    winners = [item for item in results if not isinstance(item, Conflict)]
    assert len(winners) == 1
    assert sum(isinstance(item, Conflict) for item in results) == 1
    assert Definition.objects.count() == Draft.objects.count() == 1
    assert IdempotencyRecord.objects.count() == 1
    replay = run_operation(
        on_behalf_of=users["owner"].pk,
        operation="definition.create",
        payload=payload,
        idempotency_key="concurrent-create",
        request_id="retry-after-concurrent-create",
    )
    assert replay.replayed and replay.result == winners[0].result
    assert Definition.objects.count() == Draft.objects.count() == 1
