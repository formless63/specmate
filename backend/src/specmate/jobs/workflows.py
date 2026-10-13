"""Deterministic orchestration. Engineering state and bytes remain in the application."""

import asyncio
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

TERMINAL = frozenset({"succeeded", "failed", "cancelled", "interrupted"})


@workflow.defn
class BuildWorkflow:
    @workflow.run
    async def run(self, reference: dict) -> dict:
        # Only immutable IDs enter history; never source bytes, credentials or recipes.
        try:
            await self.call("dispatch_build", reference)
            while True:
                status = await self.call("poll_build", reference)
                if status["state"] in TERMINAL:
                    return status
                await workflow.sleep(timedelta(seconds=5))
                if workflow.info().is_continue_as_new_suggested():
                    workflow.continue_as_new(reference)
        except asyncio.CancelledError:
            # Temporal cancellation requests cancellation in the application too. The
            # runner still must stop/reconcile the process before it reports cancelled.
            await self.call("cancel_build", reference)
            raise

    @staticmethod
    async def call(name: str, reference: dict) -> dict:
        return await workflow.execute_activity(
            name,
            reference,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_interval=timedelta(seconds=30)),
        )
