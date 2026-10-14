"""Declared access requirements for registered operations.

Each operation declares its minimum access floor at registration (``access=`` on the
``operation`` decorator); this module only reads that declaration from the registry. The
floor is a necessary condition for the operation to be available (object-level checks,
expected-state tokens and rights still apply, and the handler's authorize() calls remain
the enforcement). An operation without a declaration is reported as "undeclared" with
unknown availability, so a consumer can tell.
"""

from __future__ import annotations

from specmate.operations.core import (
    AUTHENTICATED,
    INSTALLATION_OWNER,
    OPERATOR,
    PUBLIC,
    RUNNER_CREDENTIAL,
    TRUSTED_JOB,
    WORKSPACE,
    OperationSpec,
    Requirement,
)

__all__ = [
    "AUTHENTICATED",
    "INSTALLATION_OWNER",
    "NON_USER_KINDS",
    "OPERATOR",
    "PUBLIC",
    "RUNNER_CREDENTIAL",
    "TRUSTED_JOB",
    "WORKSPACE",
    "Requirement",
    "requirement_for",
]

# Non-interactive actors cannot satisfy a user's workspace role.
NON_USER_KINDS = frozenset({RUNNER_CREDENTIAL, TRUSTED_JOB, OPERATOR})


def requirement_for(spec: OperationSpec) -> tuple[Requirement, str] | None:
    """Return (declared requirement, basis), or None when the operation declares none."""
    if spec.access is None:
        return None
    return spec.access, "declared"
