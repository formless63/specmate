"""Dispatch failure windows; these tests do not claim a real Temporal server."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.testing import ActivityEnvironment
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner
from temporalio.workflow import _Definition

from specmate.jobs import activities, dispatcher
from specmate.jobs.workflows import BuildWorkflow
from specmate.operations import Conflict, PermissionDenied


@pytest.fixture
def outbox(monkeypatch):
    row = SimpleNamespace(id="outbox-id", build_id="build-id", actor_id=42, workflow_id="stable-id")
    state = {"pending": True, "acks": 0, "errors": []}

    def ready(*, limit):
        assert limit > 0
        return [row] if state["pending"] else []

    def ack(identifier):
        assert identifier == row.id
        state["acks"] += 1
        state["pending"] = False

    monkeypatch.setattr(dispatcher, "ready_outbox", ready)
    monkeypatch.setattr(dispatcher, "ack_outbox", ack)
    monkeypatch.setattr(
        dispatcher, "record_dispatch_failure", lambda _id, code: state["errors"].append(code)
    )
    return state


def test_failed_start_remains_pending_and_retry_uses_same_identity(outbox):
    client = SimpleNamespace(start_workflow=AsyncMock(side_effect=[TimeoutError(), None]))
    assert asyncio.run(dispatcher.dispatch_batch(client, "queue")) == 0
    assert outbox["pending"] and outbox["acks"] == 0
    assert outbox["errors"] == ["TimeoutError"]
    assert asyncio.run(dispatcher.dispatch_batch(client, "queue")) == 1
    assert not outbox["pending"]
    calls = client.start_workflow.call_args_list
    assert calls[0] == calls[1]
    assert calls[0].kwargs["id"] == "stable-id"
    assert calls[0].kwargs["id_reuse_policy"] == WorkflowIDReusePolicy.REJECT_DUPLICATE
    assert calls[0].args[1] == {"build_id": "build-id", "actor_id": 42}


def test_lost_ack_retries_start_and_accepts_existing_workflow(outbox, monkeypatch):
    actual_ack = dispatcher.ack_outbox
    client = SimpleNamespace(start_workflow=AsyncMock(return_value=None))

    def lost_ack(_id):
        raise ConnectionError("database unavailable after successful start")

    monkeypatch.setattr(dispatcher, "ack_outbox", lost_ack)
    with pytest.raises(ConnectionError):
        asyncio.run(dispatcher.dispatch_batch(client, "queue"))
    assert outbox["pending"]
    monkeypatch.setattr(dispatcher, "ack_outbox", actual_ack)
    client.start_workflow.side_effect = WorkflowAlreadyStartedError("stable-id", "BuildWorkflow")
    assert asyncio.run(dispatcher.dispatch_batch(client, "queue")) == 1
    assert outbox["acks"] == 1
    assert client.start_workflow.call_args_list[0] == client.start_workflow.call_args_list[1]


def test_delivered_outbox_is_not_started_again(outbox):
    client = SimpleNamespace(start_workflow=AsyncMock())
    assert asyncio.run(dispatcher.dispatch_batch(client, "queue")) == 1
    assert asyncio.run(dispatcher.dispatch_batch(client, "queue")) == 0
    assert client.start_workflow.await_count == 1


def test_workflow_can_run_in_deterministic_sandbox():
    async def prepare():
        SandboxedWorkflowRunner().prepare_workflow(_Definition.must_from_class(BuildWorkflow))

    asyncio.run(prepare())


def test_temporal_cancel_uses_current_state_through_operation_layer(monkeypatch):
    calls = []

    def run_operation(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(result={"state_token": "stage-v7"})

    monkeypatch.setattr(activities, "run_operation", run_operation)
    ActivityEnvironment().run(activities.cancel_build, {"actor_id": 3, "build_id": "build-id"})
    assert [c["operation"] for c in calls] == ["build.poll", "build.cancel"]
    assert calls[1]["expected_state"] == "stage-v7"
    assert all(c["on_behalf_of"] == 3 for c in calls)


@pytest.mark.parametrize("error,retryable", [(Conflict, True), (PermissionDenied, False)])
def test_activity_errors_hide_details_and_only_retry_conflicts(monkeypatch, error, retryable):
    from temporalio.exceptions import ApplicationError

    def fail(**kwargs):
        raise error("sensitive detail")

    monkeypatch.setattr(activities, "run_operation", fail)
    with pytest.raises(ApplicationError) as exc:
        ActivityEnvironment().run(
            activities.dispatch_build, {"actor_id": 3, "build_id": "build-id"}
        )
    assert exc.value.non_retryable is not retryable
    assert "sensitive detail" not in str(exc.value)
