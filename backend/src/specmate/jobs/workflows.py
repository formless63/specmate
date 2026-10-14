"""Deterministic orchestration. Engineering state and bytes remain in the application."""

import asyncio
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

# An interrupted stage is not final: its runner may still reconcile the original
# execution, and revocation or expiry must keep being observed until a receipt or a
# deliberate build.abandon resolves it.
FINAL = frozenset({"succeeded", "failed", "cancelled"})
POLL_SECONDS = 5
INTERRUPTED_POLL_SECONDS = 30


def poll_delay(state: str) -> timedelta:
    return timedelta(seconds=INTERRUPTED_POLL_SECONDS if state == "interrupted" else POLL_SECONDS)


@workflow.defn
class BuildWorkflow:
    @workflow.run
    async def run(self, reference: dict) -> dict:
        # Only immutable IDs enter history; never source bytes, credentials or recipes.
        try:
            await self.call("dispatch_build", reference)
            while True:
                status = await self.call("poll_build", reference)
                if status["state"] in FINAL:
                    return status
                await workflow.sleep(poll_delay(status["state"]))
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
