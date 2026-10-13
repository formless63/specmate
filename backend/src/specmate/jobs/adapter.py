"""Trusted jobs adapter. Jobs act on behalf of the requesting user and go through the
same execute() path as every other transport; there is no privileged write path."""

from __future__ import annotations

from collections.abc import Mapping
from typing import IO, Any

from django.contrib.auth import get_user_model

from specmate.operations import Context, OperationResult, Unauthenticated, execute


def run_operation(
    *,
    on_behalf_of: int,
    operation: str,
    payload: Mapping[str, Any],
    request_id: str,
    idempotency_key: str | None = None,
    expected_state: str | None = None,
    attachments: Mapping[str, IO[bytes]] | None = None,
) -> OperationResult:
    user = get_user_model().objects.filter(pk=on_behalf_of).first()
    # These internal build operations recheck the original actor and execution
    # authority, then cancel revoked work. Deactivation must not disable cleanup.
    cleanup_operation = operation in {"build.poll", "build.dispatch"}
    if user is None or (not user.is_active and not cleanup_operation):
        raise Unauthenticated("Job actor is not an active user.")
    ctx = Context(
        user=user,
        via="job",
        request_id=request_id,
        idempotency_key=idempotency_key,
        expected_state=expected_state,
        attachments=attachments or {},
    )
    return execute(operation, ctx, payload)
