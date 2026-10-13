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
    user = get_user_model().objects.filter(pk=on_behalf_of, is_active=True).first()
    if user is None:
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
