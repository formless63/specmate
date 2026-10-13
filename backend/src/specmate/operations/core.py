"""Operation registry, request context, typed errors and the single execute() path.

Every mutation of engineering state goes through execute(): payload validation,
authentication, idempotency and one database transaction. Handlers perform scope
resolution and authorization themselves via specmate.access, inside that transaction.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import IO, Any, Literal

from django.db import IntegrityError, transaction
from pydantic import BaseModel, ConfigDict
from pydantic import ValidationError as PydanticValidationError

Via = Literal["api", "job", "mcp", "internal"]
ResultStatus = Literal["completed", "accepted_async"]


class OperationError(Exception):
    code = "failed"
    http_status = 400

    def __init__(self, message: str, *, details: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class ValidationFailed(OperationError):
    code = "validation_failed"
    http_status = 422


class Unauthenticated(OperationError):
    code = "unauthenticated"
    http_status = 401


class PermissionDenied(OperationError):
    code = "permission_denied"
    http_status = 403


class NotFound(OperationError):
    """Also returned for records outside the actor's scope, so existence never leaks."""

    code = "not_found"
    http_status = 404


class Conflict(OperationError):
    code = "conflict"
    http_status = 409


class IdempotencyMismatch(OperationError):
    code = "idempotency_mismatch"
    http_status = 409


class Unsupported(OperationError):
    code = "unsupported"
    http_status = 404


@dataclass(frozen=True)
class Context:
    """Server-derived request context. Never built from caller-supplied identity."""

    user: Any  # authenticated django user, or None for public operations
    via: Via
    request_id: str
    idempotency_key: str | None = None
    expected_state: str | None = None
    attachments: Mapping[str, IO[bytes]] = field(default_factory=dict)
    request: Any = None  # transport request, when the transport has one

    def require_expected_state(self) -> str:
        if not self.expected_state:
            raise ValidationFailed("This operation requires expected_state.")
        return self.expected_state


class OperationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: str
    request_id: str
    status: ResultStatus = "completed"
    replayed: bool = False
    result: dict[str, Any]


@dataclass(frozen=True)
class OperationSpec:
    name: str
    summary: str
    payload: type[BaseModel]
    handler: Callable[[Context, Any], dict[str, Any]]
    requires_expected_state: bool
    public: bool
    attachments: tuple[str, ...]
    status: ResultStatus
    authorize_replay: Callable[[Context, BaseModel, Mapping[str, Any]], None] | None = None
    supports_idempotency: bool = True
    idempotency_scope: Callable[[Context, BaseModel], str] | None = None


registry: dict[str, OperationSpec] = {}


def operation(
    name: str,
    payload: type[BaseModel],
    *,
    summary: str,
    requires_expected_state: bool = False,
    public: bool = False,
    attachments: tuple[str, ...] = (),
    status: ResultStatus = "completed",
    authorize_replay: Callable[[Context, BaseModel, Mapping[str, Any]], None] | None = None,
    supports_idempotency: bool = True,
    idempotency_scope: Callable[[Context, BaseModel], str] | None = None,
):
    def register(handler: Callable[[Context, Any], dict[str, Any]]):
        if name in registry:
            raise RuntimeError(f"Duplicate operation {name}")
        registry[name] = OperationSpec(
            name,
            summary,
            payload,
            handler,
            requires_expected_state,
            public,
            attachments,
            status,
            authorize_replay,
            supports_idempotency,
            idempotency_scope,
        )
        return handler

    return register


def _fingerprint(name: str, ctx: Context, payload: dict[str, Any]) -> str:
    material = {"operation": name, "expected_state": ctx.expected_state, "payload": payload}
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def execute(name: str, ctx: Context, payload: Mapping[str, Any]) -> OperationResult:
    spec = registry.get(name)
    if spec is None:
        raise Unsupported(f"Unknown operation {name!r}.")
    if not spec.public and (ctx.user is None or not ctx.user.is_authenticated):
        raise Unauthenticated("Authentication required.")
    # Sessions and in-process callers can hold stale user objects. Refresh account
    # liveness before both fresh execution and replay; trusted cleanup stays possible.
    from django.contrib.auth import get_user_model

    user_model = get_user_model()
    if isinstance(ctx.user, user_model):
        current = user_model.objects.filter(pk=ctx.user.pk).first()
        cleanup = ctx.via == "job" and name in {"build.poll", "build.dispatch"}
        if current is None or (not current.is_active and not cleanup):
            raise Unauthenticated("Actor is not active.")
        ctx = replace(ctx, user=current)
    if ctx.idempotency_key is not None and not spec.supports_idempotency:
        raise ValidationFailed(
            "This operation requires fresh evaluation, without an idempotency key."
        )
    try:
        parsed = spec.payload.model_validate(dict(payload))
    except PydanticValidationError as exc:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        raise ValidationFailed("Invalid payload.", details={"errors": errors}) from None
    if spec.requires_expected_state:
        ctx.require_expected_state()
    for attachment in spec.attachments:
        if attachment not in ctx.attachments:
            raise ValidationFailed(f"Missing attachment {attachment!r}.")

    keyed = ctx.idempotency_key is not None and ctx.user is not None
    fingerprint = _fingerprint(name, ctx, parsed.model_dump(mode="json")) if keyed else ""
    with transaction.atomic():
        if keyed:
            from specmate.operations.models import IdempotencyRecord
            from specmate.operations.scope import LEGACY_SCOPE, builtin_scope, validated_scope

            scope = validated_scope(
                spec.idempotency_scope(ctx, parsed)
                if spec.idempotency_scope is not None
                else builtin_scope(name, ctx, parsed)
            )
            records = IdempotencyRecord.objects.select_for_update().filter(
                actor=ctx.user, operation=name, key=ctx.idempotency_key
            )
            prior = records.filter(scope=scope).first()
            legacy = False
            if prior is None:
                prior = records.filter(scope=LEGACY_SCOPE).first()
                legacy = prior is not None
                if prior is None:
                    # A concurrent request may have just adopted the legacy row.
                    prior = records.filter(scope=scope).first()
            if prior is not None:
                if prior.fingerprint != fingerprint:
                    if legacy:
                        raise Conflict(
                            "This key has an unresolved legacy outcome; use a new key for new work."
                        )
                    raise IdempotencyMismatch("Idempotency key was used with a different request.")
                if spec.authorize_replay is not None:
                    spec.authorize_replay(ctx, parsed, prior.result)
                else:
                    from specmate.operations.replay import authorize_builtin_replay

                    authorize_builtin_replay(name, ctx, parsed, prior.result)
                if legacy:
                    # Adopt only after exact fingerprint and current authority checks.
                    # Never execute the handler again for a retained legacy outcome.
                    prior.scope = scope
                    prior.save(update_fields=["scope"])
                return OperationResult(
                    operation=name,
                    request_id=ctx.request_id,
                    status=spec.status,
                    replayed=True,
                    result=prior.result,
                )
        result = spec.handler(ctx, parsed)
        if keyed:
            try:
                with transaction.atomic():
                    IdempotencyRecord.objects.create(
                        actor=ctx.user,
                        scope=scope,
                        operation=name,
                        key=ctx.idempotency_key,
                        fingerprint=fingerprint,
                        result=result,
                    )
            except IntegrityError:
                # A concurrent request with the same key committed first; undo this one.
                raise Conflict("A concurrent request with this idempotency key won.") from None
    return OperationResult(
        operation=name, request_id=ctx.request_id, status=spec.status, result=result
    )
