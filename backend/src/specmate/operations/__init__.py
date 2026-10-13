"""The shared controlled-operation layer used by every entry point (API, MCP, jobs)."""

from specmate.operations.core import (
    Conflict,
    Context,
    IdempotencyMismatch,
    NotFound,
    OperationError,
    OperationResult,
    OperationSpec,
    PermissionDenied,
    Unauthenticated,
    Unsupported,
    ValidationFailed,
    execute,
    operation,
    registry,
)

__all__ = [
    "Conflict",
    "Context",
    "IdempotencyMismatch",
    "NotFound",
    "OperationError",
    "OperationResult",
    "OperationSpec",
    "PermissionDenied",
    "Unauthenticated",
    "Unsupported",
    "ValidationFailed",
    "execute",
    "operation",
    "registry",
]
