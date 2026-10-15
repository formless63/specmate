"""Preference reads. Every value is labeled as a preference, never as an engineering fact."""

from __future__ import annotations

from specmate.access.models import Workspace
from specmate.access.permissions import Perm, authorize
from specmate.preferences.contracts import KEYS
from specmate.preferences.models import MakerPreferences

NOTE = (
    "Preferences are defaults for forms and agents. They are not ratings, tolerances, "
    "compatibility or any other engineering fact; a fact with no evidence stays unknown."
)


def token(row: MakerPreferences | None) -> str:
    return f"preferences-v{row.version if row else 0}"


def rows(workspace_id, user) -> tuple[MakerPreferences | None, MakerPreferences | None]:
    base = MakerPreferences.objects.filter(workspace_id=workspace_id)
    return base.filter(user__isnull=True).first(), base.filter(user=user).first()


def describe_preferences(workspace_id, user) -> dict:
    shared, own = rows(workspace_id, user)
    shared_values = shared.values if shared else {}
    own_values = own.values if own else {}
    effective = {}
    for key in KEYS:
        if key in own_values:
            effective[key] = {"value": own_values[key], "source": "user"}
        elif key in shared_values:
            effective[key] = {"value": shared_values[key], "source": "workspace"}
        else:
            effective[key] = {"value": None, "source": "none"}
    return {
        "workspace_id": str(workspace_id),
        "kind": "preference",
        "engineering_fact": False,
        "workspace": {"values": shared_values, "state_token": token(shared)},
        "user": {"values": own_values, "state_token": token(own)},
        "effective": effective,
        "note": NOTE,
    }


def read(user, workspace_id) -> dict:
    workspace: Workspace = authorize(user, workspace_id, Perm.WORKSPACE_READ)
    return describe_preferences(workspace.id, user)
