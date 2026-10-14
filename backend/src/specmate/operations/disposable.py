"""OPS-007: verify a disposable pre-1.0 installation before any destructive reset.

A reset is allowed only when every identity below agrees. The verified marker is
the authority; the environment name is not consulted. DEBUG, a localhost hostname
or a version number alone never suffices, and an unknown or ambiguous target is
always refused. Verification is read-only.

The installation marker is a JSON file kept outside the application checkout, in
the disposable stack's own state directory:

    {"schema": 1, "policy": "pre-1.0-disposable", "installation_id": "<uuid>",
     "database": {"host": "...", "port": "...", "name": "..."},
     "state_root": "/abs/dedicated/state/root",
     "artifact_root": "/abs/dedicated/state/root/<subdir>"}
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import uuid
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

from django.conf import settings
from django.db import connection

MARKER_SCHEMA = 1
MARKER_POLICY = "pre-1.0-disposable"
ACTIVE_STAGE_STATES = ("waiting_dispatch", "queued", "leased", "running", "cancellation_requested")


class ResetRefused(Exception):
    """The target is not a verified disposable installation, or is not quiescent."""


@dataclass(frozen=True)
class Verified:
    installation_id: uuid.UUID
    database_name: str
    state_root: Path
    artifact_root: Path
    installation_row_exists: bool


def _version_is_pre_release() -> bool:
    try:
        major = int(metadata.version("specmate").split(".")[0])
    except (metadata.PackageNotFoundError, ValueError):
        return False
    return major < 1


def _load_marker(path: str | None) -> dict:
    if not path:
        raise ResetRefused("No installation marker is configured (SPECMATE_DISPOSABLE_MARKER).")
    p = Path(path)
    if not p.is_absolute():
        raise ResetRefused("The installation marker path must be absolute.")
    try:
        st = p.lstat()
    except OSError:
        raise ResetRefused("The installation marker is missing.") from None
    if not stat.S_ISREG(st.st_mode):
        raise ResetRefused("The installation marker must be a regular file, not a link.")
    try:
        marker = json.loads(p.read_text())
    except (OSError, ValueError):
        raise ResetRefused("The installation marker is unreadable or not valid JSON.") from None
    if not isinstance(marker, dict):
        raise ResetRefused("The installation marker is malformed.")
    if marker.get("schema") != MARKER_SCHEMA or marker.get("policy") != MARKER_POLICY:
        raise ResetRefused("The installation marker does not declare a pre-1.0 disposable policy.")
    return marker


def _bounded_dir(raw, label: str) -> Path:
    if not isinstance(raw, str) or not os.path.isabs(raw):
        raise ResetRefused(f"The marker {label} must be an absolute path.")
    path = Path(raw)
    if ".." in path.parts or path.resolve() != path:
        raise ResetRefused(f"The marker {label} must not traverse links or relative segments.")
    if len(path.parts) < 4 or path == Path.home() or path in Path.home().parents:
        raise ResetRefused(f"The marker {label} is too broad to be a dedicated state root.")
    return path


def verify(marker_path: str | None = None) -> Verified:
    """Raise ResetRefused unless this process targets the marked disposable installation."""
    from specmate.access.models import Installation

    if not _version_is_pre_release():
        raise ResetRefused("Resets are only permitted before v1.0.0.")
    marker = _load_marker(
        marker_path if marker_path is not None else os.environ.get("SPECMATE_DISPOSABLE_MARKER")
    )
    try:
        marker_id = uuid.UUID(str(marker.get("installation_id")))
    except ValueError:
        raise ResetRefused("The marker installation_id is not a UUID.") from None

    db = settings.DATABASES["default"]
    declared = marker.get("database")
    if not isinstance(declared, dict):
        raise ResetRefused("The marker does not declare a database identity.")
    for key in ("host", "port", "name"):
        configured = str(db.get(key.upper(), ""))
        if not declared.get(key) or str(declared[key]) != configured:
            raise ResetRefused(f"Configured database {key} does not match the marker.")

    state_root = _bounded_dir(marker.get("state_root"), "state_root")
    artifact_root = _bounded_dir(marker.get("artifact_root"), "artifact_root")
    if state_root not in artifact_root.parents:
        raise ResetRefused("The marker artifact_root must lie strictly inside its state_root.")
    if Path(os.path.normpath(settings.SPECMATE_ARTIFACT_ROOT)) != artifact_root:
        raise ResetRefused("Configured artifact root does not match the marker.")

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database()")
            if cursor.fetchone()[0] != db["NAME"]:
                raise ResetRefused("Connected database identity differs from configuration.")
            cursor.execute("SELECT to_regclass('public.access_installation') IS NOT NULL")
            has_table = cursor.fetchone()[0]
            cursor.execute("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
            table_count = cursor.fetchone()[0]
    except ResetRefused:
        raise
    except Exception as exc:
        raise ResetRefused(f"Database target could not be verified: {type(exc).__name__}") from None

    row_exists = False
    if has_table:
        row = Installation.objects.filter(singleton=True).first()
        if row is not None:
            row_exists = True
            if row.installation_id != marker_id:
                raise ResetRefused("The installation ID does not match the marker.")
    if not row_exists and table_count > 0:
        raise ResetRefused("The database holds data but no installation identity; refusing.")
    return Verified(marker_id, db["NAME"], state_root, artifact_root, row_exists)


def assert_quiescent() -> None:
    """Native execution must be stopped and reconciled, and no runner may be authorised."""
    from django.utils import timezone

    from specmate.builds.models import BuildStage, RunnerCredential

    active = BuildStage.objects.filter(state__in=ACTIVE_STAGE_STATES).count()
    if active:
        raise ResetRefused(f"{active} build stage(s) are active; stop and reconcile them first.")
    live = RunnerCredential.objects.filter(revoked_at__isnull=True, expires_at__gt=timezone.now())
    if live.exists():
        raise ResetRefused("Active runner credentials exist; revoke them first.")


def clear_artifact_root(verified: Verified) -> int:
    """Remove the children of the marked artifact root only; links are unlinked, not followed."""
    root = verified.artifact_root
    if root.is_symlink() or (root.exists() and root.resolve() != root):
        raise ResetRefused("The artifact root changed to a link; refusing.")
    removed = 0
    if not root.exists():
        root.mkdir(parents=True)
        return 0
    for child in root.iterdir():
        if child.is_symlink() or child.is_file():
            child.unlink()
        else:
            shutil.rmtree(child)
        removed += 1
    return removed


def reset_database(verified: Verified) -> None:
    """Recreate the schema of the one verified database, then rebuild the baseline."""
    from django.core.management import call_command

    from specmate.access.models import Installation

    with connection.cursor() as cursor:
        cursor.execute("DROP SCHEMA public CASCADE")
        cursor.execute("CREATE SCHEMA public")
    connection.close()
    call_command("migrate", interactive=False, verbosity=0)
    # The marker identity survives a reset, so the same disposable install stays recognised.
    Installation.objects.update_or_create(
        singleton=True, defaults={"installation_id": verified.installation_id}
    )
