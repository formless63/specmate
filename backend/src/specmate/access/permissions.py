"""Project-scoped authorization, evaluated in the operation layer for every transport."""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from specmate.access.models import Membership, Project
from specmate.operations import NotFound, PermissionDenied


class Perm(StrEnum):
    PROJECT_READ = "project.read"
    PROJECT_ADMIN = "project.admin"
    DESIGN_EDIT = "design.edit"
    DESIGN_FREEZE = "design.freeze"
    SOURCE_REGISTER = "source.register"


# Freezing is separate engineering authority: editors need an explicit grant.
ROLE_PERMISSIONS: dict[str, frozenset[Perm]] = {
    Membership.Role.OWNER: frozenset(Perm),
    Membership.Role.EDITOR: frozenset({Perm.PROJECT_READ, Perm.DESIGN_EDIT, Perm.SOURCE_REGISTER}),
    Membership.Role.VIEWER: frozenset({Perm.PROJECT_READ}),
}


def permissions_for(membership: Membership) -> frozenset[Perm]:
    granted = {Perm(g) for g in membership.grants if g in Perm._value2member_map_}
    return ROLE_PERMISSIONS[membership.role] | granted


def visible_projects(user: Any):
    if user is None or not user.is_authenticated:
        return Project.objects.none()
    return Project.objects.filter(memberships__user=user)


def authorize(user: Any, project_id: Any, perm: Perm) -> Project:
    """Return the project if the user holds perm. Non-members get NotFound, not a denial."""
    membership = (
        Membership.objects.select_related("project")
        .filter(project_id=project_id, user=user)
        .first()
        if user is not None and user.is_authenticated
        else None
    )
    if membership is None:
        raise NotFound("Project not found.")
    if perm not in permissions_for(membership):
        raise PermissionDenied(f"Missing permission {perm.value}.")
    return membership.project
