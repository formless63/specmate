"""Which operations a run may hold, and which are boundaries that need an explicit grant.

Draft-level work (create items, edit drafts, register sources, edit projects, read) is
grantable as ordinary allowed actions. Freezing, native execution, inventory, release,
administration and irreversible deletion are boundaries: a run stops in front of them
unless the sponsor grants each one by name. Only workspace operations without uploads are
grantable at all; the run operations themselves never are.
"""

from __future__ import annotations

from specmate.access.permissions import Perm
from specmate.operations import OperationSpec, ValidationFailed, registry
from specmate.operations.core import WORKSPACE

# Permissions whose operations are reversible draft-level work.
DRAFT_PERMISSIONS = frozenset(
    {
        Perm.WORKSPACE_READ,
        Perm.ITEM_CREATE,
        Perm.PROJECT_EDIT,
        Perm.DESIGN_EDIT,
        Perm.SOURCE_REGISTER,
    }
)
# Operations whose floor is draft-level but whose effect cannot be undone.
IRREVERSIBLE = frozenset({"project.delete"})


def not_grantable_reason(spec: OperationSpec | None) -> str | None:
    if spec is None:
        return "unknown_operation"
    if spec.name.startswith("agent_run."):
        return "run_operation"
    if spec.access is None:
        return "access_not_declared"
    if spec.access.kind != WORKSPACE or spec.public:
        return "not_a_workspace_operation"
    if spec.attachments:
        return "requires_upload"
    return None


def boundary_reason(spec: OperationSpec) -> str | None:
    """Why this operation is a boundary (execution, release, inventory, ...), or None."""
    floor = spec.access.permission
    if floor not in DRAFT_PERMISSIONS:
        return f"requires {floor.value}"
    if spec.status == "accepted_async" or "recipe_id" in spec.payload.model_fields:
        return "native execution"
    if spec.name in IRREVERSIBLE:
        return "irreversible"
    return None


def classify(name: str) -> dict:
    spec = registry.get(name)
    blocked = not_grantable_reason(spec)
    if blocked:
        return {"operation": name, "grantable": False, "reason": blocked}
    boundary = boundary_reason(spec)
    return {
        "operation": name,
        "grantable": True,
        "boundary": boundary is not None,
        "reason": boundary,
        "permission": spec.access.permission.value,
    }


def validate_grant(
    allowed: list[str], boundary: list[str], held: frozenset[Perm]
) -> tuple[list[str], list[str]]:
    """Normalize and check a grant against the sponsor's current permissions."""
    errors = []
    if len(set(allowed)) != len(allowed) or len(set(boundary)) != len(boundary):
        errors.append({"loc": ["actions"], "msg": "Actions must be unique."})
    if set(allowed) & set(boundary):
        errors.append({"loc": ["actions"], "msg": "An action is listed twice."})
    for field, names, want_boundary in (
        ("allowed_actions", allowed, False),
        ("boundary_actions", boundary, True),
    ):
        for name in names:
            info = classify(name)
            if not info["grantable"]:
                errors.append({"loc": [field, name], "msg": info["reason"]})
            elif info["boundary"] != want_boundary:
                msg = (
                    f"boundary operation ({info['reason']}); grant it in boundary_actions"
                    if info["boundary"]
                    else "not a boundary operation; list it in allowed_actions"
                )
                errors.append({"loc": [field, name], "msg": msg})
            elif Perm(info["permission"]) not in held:
                errors.append({"loc": [field, name], "msg": f"sponsor lacks {info['permission']}"})
    if errors:
        raise ValidationFailed(
            "The run grant is not valid for this sponsor.", details={"errors": errors}
        )
    return sorted(allowed), sorted(boundary)


def delegated_permissions(held: frozenset[Perm], boundary: list[str]) -> frozenset[Perm]:
    """The cap applied while a run acts: the sponsor's draft-level permissions plus the
    floor permission of each explicitly granted boundary operation, never more."""
    extra = {registry[name].access.permission for name in boundary if name in registry}
    if Perm.INVENTORY_MANAGE in extra:
        extra.add(Perm.INVENTORY_RESERVE)
    return frozenset(held & (DRAFT_PERMISSIONS | extra))
