"""At-least-once outbox delivery with a stable, non-reusable Temporal workflow ID."""

import asyncio
import logging
from datetime import timedelta

from asgiref.sync import sync_to_async
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from specmate.builds.dispatch import ack_outbox, ready_outbox, record_dispatch_failure
from specmate.jobs.workflows import BuildWorkflow

logger = logging.getLogger(__name__)


async def dispatch_batch(client, task_queue: str, *, limit: int = 20) -> int:
    delivered = 0
    for item in await sync_to_async(ready_outbox)(limit=limit):
        try:
            await client.start_workflow(
                BuildWorkflow.run,
                {"build_id": str(item.build_id), "actor_id": item.actor_id},
                id=item.workflow_id,
                task_queue=task_queue,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                rpc_timeout=timedelta(seconds=10),
            )
        except WorkflowAlreadyStartedError:
            # Start committed before an earlier acknowledgement was lost. The same
            # identifier also rejects restarting a completed logical build.
            pass
        except Exception as exc:
            await sync_to_async(record_dispatch_failure)(item.id, type(exc).__name__)
            logger.warning("Workflow dispatch failed: %s", type(exc).__name__)
            continue
        await sync_to_async(ack_outbox)(item.id)
        delivered += 1
    return delivered


async def dispatch_forever(client, task_queue: str, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await dispatch_batch(client, task_queue)
        except Exception as exc:
            # A transient DB outage must not permanently kill dispatch in a live worker.
            logger.warning("Outbox unavailable: %s", type(exc).__name__)
        try:
            await asyncio.wait_for(stop.wait(), timeout=2)
        except TimeoutError:
            pass
