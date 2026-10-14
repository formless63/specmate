"""Build the capability answer from the live registry and the real permission layer."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from importlib.metadata import version
from typing import Any
from uuid import UUID

from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone

from specmate.access.models import Installation
from specmate.access.permissions import Perm, authorize, membership, permissions_for
from specmate.builds.models import RunnerCredential
from specmate.discovery import requirements as req
from specmate.operations import Context, OperationSpec, PermissionDenied, registry


def _transports() -> dict[str, dict]:
    mcp = importlib.util.find_spec("specmate.mcp") is not None
    return {
        "http_api": {"status": "available", "invoke": "POST /api/v0/operations (envelope)"},
        "mcp": (
            {"status": "available"}
            if mcp
            else {"status": "unavailable", "reason": "no_mcp_adapter_in_this_instance"}
        ),
    }


def _native_execution(workspace_id: UUID | None, held: frozenset[Perm]) -> dict:
    """Whether native tool requests can be accepted and executed here."""
    recipes = sorted(settings.SPECMATE_APPROVED_RECIPES)
    if not recipes:
        return {"status": "unavailable", "reasons": ["no_approved_recipe"], "approved_recipes": 0}
    result: dict[str, Any] = {
        "status": "available",
        "reasons": [],
        "approved_recipes": len(recipes),
    }
    if workspace_id is not None:
        active = RunnerCredential.objects.filter(
            workspace_id=workspace_id, revoked_at__isnull=True, expires_at__gt=timezone.now()
        )
        if not active.exists():
            result["status"] = "degraded"
            result["reasons"] = ["no_active_runner_for_project"]
        if Perm.BUILD_EXECUTE in held:
            # Recipe ids are execution configuration: only show them to actors who may request.
            result["approved_recipe_ids"] = recipes
    return result


def _availability(
    name: str,
    spec: OperationSpec,
    requirement: req.Requirement | None,
    ctx: Context,
    scope: dict | None,
    held: frozenset[Perm],
    is_owner: bool,
    native: dict,
) -> dict:
    def out(status: str, *reasons: str, **extra) -> dict:
        return {"status": status, "reasons": list(reasons), **extra}

    if requirement is None:
        return out("unknown", "requirement_not_declared")
    kind = requirement.kind
    if kind == req.PUBLIC:
        return out("not_applicable", "pre_authentication_operation")
    if kind in req.NON_USER_KINDS or kind == req.RUNNER_CREDENTIAL:
        return out("not_applicable", f"{kind}_only")
    if kind == req.INSTALLATION_OWNER and not is_owner:
        return out("not_permitted", "installation_owner_required")
    if kind in {req.AUTHENTICATED, req.INSTALLATION_OWNER}:
        return out("available")
    needed = requirement.permission
    if scope is None:
        return out("scope_required", "project_id_required", requires=needed.value)
    if needed not in held:
        return out("not_permitted", "missing_permission", missing=needed.value)
    if "recipe_id" in spec.payload.model_fields:
        status = native["status"]
        if status == "unavailable":
            return out("unavailable", *native["reasons"])
        if status == "degraded":
            return out("degraded", *native["reasons"])
    return out("available")


def describe(ctx: Context, project_id: UUID | None, include_schemas: bool) -> dict:
    if not isinstance(ctx.user, get_user_model()):
        raise PermissionDenied("Discovery requires an interactive account actor.")
    held: frozenset[Perm] = frozenset()
    scope = None
    if project_id is not None:
        # Non-members get NotFound, exactly like every other scoped read.
        workspace = authorize(ctx.user, project_id, Perm.WORKSPACE_READ)
        member = membership(ctx.user, workspace.id)
        held = permissions_for(member)
        scope = {
            "project_id": str(project_id),
            "workspace_id": str(workspace.id),
            "role": member.role,
            "permissions": sorted(p.value for p in held),
        }
    installation = Installation.objects.filter(singleton=True).first()
    is_owner = installation is not None and installation.owner_id == ctx.user.pk
    native = _native_execution(workspace.id if project_id is not None else None, held)

    operations = []
    digest_material = []
    for name, spec in sorted(registry.items()):
        schema = spec.payload.model_json_schema()
        digest_material.append(
            [name, schema, spec.requires_expected_state, spec.supports_idempotency]
        )
        found = req.requirement_for(
            name, supports_idempotency=spec.supports_idempotency, public=spec.public
        )
        requirement, basis = found if found else (None, "undeclared")
        row: dict[str, Any] = {
            "operation": name,
            "summary": spec.summary,
            "requires_expected_state": spec.requires_expected_state,
            "supports_idempotency": spec.supports_idempotency,
            "attachments": list(spec.attachments),
            "async": spec.status == "accepted_async",
            "generic_http_invocation": not spec.public and not spec.attachments,
            "access": {
                "kind": requirement.kind if requirement else "undeclared",
                "minimum_project_permission": (
                    requirement.permission.value if requirement and requirement.permission else None
                ),
                "basis": basis,
            },
            "availability": _availability(
                name, spec, requirement, ctx, scope, held, is_owner, native
            ),
        }
        if include_schemas:
            row["payload_schema"] = schema
        operations.append(row)

    digest = hashlib.sha256(
        json.dumps(digest_material, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "instance": {"version": version("specmate"), "registry_sha256": digest},
        "transports": _transports(),
        "actor": {"via": ctx.via, "installation_owner": is_owner},
        "scope": scope,
        "capabilities": {"native_execution": native},
        "notes": [
            "available means the actor's role satisfies the operation's minimum project "
            "permission and no capability is missing; object-level authority, expected-state "
            "tokens and rights are still checked when the operation runs.",
        ],
        "operations": operations,
    }
