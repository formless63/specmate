"""Start the application worker: python -m specmate.jobs.worker."""

import asyncio
import os
import signal
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta


async def serve():
    from django.conf import settings
    from temporalio.client import Client
    from temporalio.worker import Worker

    from specmate.jobs.activities import cancel_build, dispatch_build, poll_build
    from specmate.jobs.dispatcher import dispatch_forever
    from specmate.jobs.workflows import BuildWorkflow

    client = await Client.connect(
        settings.SPECMATE_TEMPORAL_ADDRESS, namespace=settings.SPECMATE_TEMPORAL_NAMESPACE
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    with ThreadPoolExecutor(max_workers=4) as executor:
        async with Worker(
            client,
            task_queue=settings.SPECMATE_TEMPORAL_TASK_QUEUE,
            workflows=[BuildWorkflow],
            activities=[dispatch_build, poll_build, cancel_build],
            activity_executor=executor,
            max_concurrent_activities=4,
            max_concurrent_workflow_tasks=4,
            graceful_shutdown_timeout=timedelta(seconds=20),
        ):
            await dispatch_forever(client, settings.SPECMATE_TEMPORAL_TASK_QUEUE, stop)


def main():
    import django
    from django.core.management import call_command

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "specmate.settings")
    django.setup()
    call_command("startup", check=True)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
