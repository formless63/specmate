"""Short trusted activities; native tools run exclusively in the scoped runner."""

from django.db import close_old_connections
from temporalio import activity
from temporalio.exceptions import ApplicationError

from specmate.jobs.adapter import run_operation
from specmate.operations import OperationError


def invoke(name: str, reference: dict, *, expected_state: str | None = None) -> dict:
    close_old_connections()
    try:
        return run_operation(
            on_behalf_of=reference["actor_id"],
            operation=name,
            payload={"build_id": reference["build_id"]},
            request_id=f"workflow-{activity.info().workflow_id}-{name}",
            expected_state=expected_state,
        ).result
    except OperationError as exc:
        # Details may contain engineering data; record only a stable error code.
        raise ApplicationError(
            exc.code, type=exc.code, non_retryable=exc.code != "conflict"
        ) from None
    finally:
        close_old_connections()


@activity.defn
def dispatch_build(reference: dict) -> dict:
    return invoke("build.dispatch", reference)


@activity.defn
def poll_build(reference: dict) -> dict:
    return invoke("build.poll", reference)


@activity.defn
def cancel_build(reference: dict) -> dict:
    current = invoke("build.poll", reference)
    return invoke("build.cancel", reference, expected_state=current["state_token"])
