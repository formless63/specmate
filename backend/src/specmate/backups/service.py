"""Coordinated backup and same-version restore of one installation.

Consistency. The application database is read through one exported REPEATABLE READ
snapshot: ``pg_dump --snapshot`` dumps exactly the state from which the manifest's
schema, work and byte references are read. Content-addressed bytes are promoted before
the database commit that references them and are never rewritten, so copying the
artifact store after the snapshot always yields a superset of what the dump references;
each referenced byte is verified by hash while it is copied.

Side effects. Workflow orchestration carries only identifiers; build stages, receipts,
leases, runner credentials and the dispatch outbox live in the application database,
which is the recovery authority. A restore therefore loads that database into an empty
target and, before any service may start, fences it: the installation enters
maintenance, every restored runner credential is revoked, undelivered dispatch is
withheld permanently, unstarted stages are cancelled with a not-started receipt and
active stages become interrupted. Nothing captured in the backup is dispatched,
leased or executed again; the operator re-authorizes execution deliberately.
"""

from __future__ import annotations

import errno
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from importlib import metadata
from pathlib import Path
from typing import IO, Any

import psycopg
from django.conf import settings
from django.db import connection, transaction
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone

from specmate.access.models import Installation
from specmate.backups import bundle, marker
from specmate.builds.models import BuildOutbox, BuildStage, RunnerCredential, StageOutput
from specmate.diagnostics.models import WorkControl
from specmate.preparation_documents.models import DocumentOutput
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob

TERMINAL = ("succeeded", "failed", "cancelled")
PENDING = ("waiting_dispatch", "queued")
ACTIVE = ("leased", "running", "cancellation_requested")
# Every table whose rows name content-addressed bytes by (sha256, size).
REFERENCES = (SourceBlob, StageOutput, DocumentOutput)
RESTORE_REASON = "restored_from_backup"
TOOL_ERROR_BYTES = 2000


class BackupError(Exception):
    """A backup or restore precondition failed; nothing unsafe was done."""


def _q(name: str) -> str:
    return connection.ops.quote_name(name)


def _table(model) -> str:
    return _q(model._meta.db_table)


def _db() -> dict[str, str]:
    s = connection.settings_dict
    return {
        "host": s.get("HOST") or "localhost",
        "port": str(s.get("PORT") or "5432"),
        "dbname": s["NAME"],
        "user": s.get("USER") or "",
        "password": s.get("PASSWORD") or "",
    }


def _tool(executable: str, args: list[str], *, connect: bool = True) -> bytes:
    """Run a PostgreSQL client tool; the password travels only in its environment."""
    db = _db()
    env = {**os.environ, "PGPASSWORD": db["password"]}
    argv = [executable, *args]
    if connect:
        argv += ["--host", db["host"], "--port", db["port"]]
        argv += ["--username", db["user"], "--dbname", db["dbname"]]
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv
            argv,
            # Never inherit stdin: the bundle itself may be arriving on it.
            stdin=subprocess.DEVNULL,
            capture_output=True,
            env=env,
            check=False,
        )
    except OSError as exc:
        raise BackupError(f"{executable} is not available: {type(exc).__name__}.") from None
    if result.returncode:
        detail = result.stderr.decode(errors="replace")[-TOOL_ERROR_BYTES:]
        raise BackupError(f"{Path(executable).name} failed (exit {result.returncode}): {detail}")
    return result.stdout


def _tool_version(executable: str) -> str:
    try:
        out = subprocess.run(  # noqa: S603
            # Never inherit stdin: the bundle itself may be arriving on it.
            [executable, "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise BackupError(f"{executable} is not available: {type(exc).__name__}.") from None
    return out.stdout.decode().strip()


def code_migrations() -> list[str]:
    loader = MigrationLoader(None, ignore_no_migrations=True)
    return sorted(f"{app}.{name}" for app, name in loader.disk_migrations)


def _app_version() -> str:
    try:
        return metadata.version("specmate")
    except metadata.PackageNotFoundError:
        return "unknown"


# ---- create ------------------------------------------------------------------------------


def _snapshot_state(cur) -> dict[str, Any]:
    """Everything the manifest states about the database, read inside the dump snapshot."""
    cur.execute("SELECT app, name FROM django_migrations")
    migrations = sorted(f"{app}.{name}" for app, name in cur.fetchall())
    cur.execute(
        f"SELECT installation_id, owner_id FROM {_table(Installation)} WHERE singleton"  # noqa: S608
    )
    row = cur.fetchone()
    if row is None or row[1] is None:
        raise BackupError("Claim the installation owner before taking a product backup.")
    cur.execute(f"SELECT mode FROM {_table(WorkControl)} WHERE singleton")  # noqa: S608
    mode = (cur.fetchone() or ["running"])[0]
    cur.execute(
        f"SELECT state, count(*) FROM {_table(BuildStage)} "  # noqa: S608
        "WHERE NOT state = ANY(%s) GROUP BY state",
        [list(TERMINAL)],
    )
    open_stages = dict(cur.fetchall())
    cur.execute(
        f"SELECT count(*) FROM {_table(BuildOutbox)} "  # noqa: S608
        "WHERE delivered_at IS NULL AND withheld_at IS NULL"
    )
    undelivered = cur.fetchone()[0]
    cur.execute(
        f"SELECT count(*) FROM {_table(RunnerCredential)} "  # noqa: S608
        "WHERE revoked_at IS NULL AND expires_at > now()"
    )
    usable = cur.fetchone()[0]
    references: set[tuple[str, int]] = set()
    for model in REFERENCES:
        cur.execute(f"SELECT DISTINCT sha256, size FROM {_table(model)}")  # noqa: S608
        references |= {(sha, int(size)) for sha, size in cur.fetchall()}
    cur.execute("SHOW server_version")
    return {
        "installation_id": str(row[0]),
        "migrations": migrations,
        "mode": mode,
        "open_stages": open_stages,
        "undelivered": undelivered,
        "usable_credentials": usable,
        "references": references,
        "server_version": cur.fetchone()[0],
    }


def _stored_blobs() -> list[tuple[str, Path]]:
    base = blobstore.root() / "blobs" / "sha256"
    if not base.is_dir():
        return []
    found = []
    for path in sorted(base.glob("*/*/*")):
        name = path.relative_to(blobstore.root()).as_posix()
        if not bundle.BLOB.match(name) or not path.is_file():
            raise BackupError(f"Unexpected entry in the artifact store: {name}.")
        found.append((path.name, path))
    return found


def _require_stored(references: set[tuple[str, int]]) -> None:
    missing = []
    for sha256, size in sorted(references):
        try:
            if blobstore.blob_path(sha256).stat().st_size != size:
                missing.append(sha256)
        except FileNotFoundError:
            missing.append(sha256)
    if missing:
        raise BackupError(
            f"{len(missing)} recorded byte objects are missing or damaged in the artifact "
            f"store (first: {missing[:3]}); a complete backup is not possible."
        )


def create_backup(
    output: IO[bytes],
    *,
    secrets_env: bytes | None,
    allow_active_work: bool = False,
    work_dir: Path | None = None,
) -> dict[str, Any]:
    pg_dump = settings.SPECMATE_PG_DUMP
    db = _db()
    with psycopg.connect(
        host=db["host"],
        port=db["port"],
        dbname=db["dbname"],
        user=db["user"],
        password=db["password"],
    ) as snap:
        with snap.cursor() as cur:
            cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            cur.execute("SELECT pg_export_snapshot()")
            snapshot_id = cur.fetchone()[0]
            state = _snapshot_state(cur)
        active = {k: v for k, v in state["open_stages"].items() if k != "interrupted"}
        if (active or state["undelivered"]) and not allow_active_work:
            raise BackupError(
                "Unfinished build work exists "
                f"({active or {}}, undelivered dispatch {state['undelivered']}). Drain work "
                "first, or pass --allow-active-work; a restore then cancels or interrupts it."
            )
        # Fail before writing anything when recorded bytes are already absent; their
        # content is verified by hash again while they are copied.
        _require_stored(state["references"])
        dump_tool = _tool_version(pg_dump)
        with tempfile.TemporaryDirectory(prefix="specmate-backup-", dir=work_dir) as tmp:
            dump = Path(tmp) / "specmate.pgdump"
            # The exporting transaction stays open until pg_dump has finished. Writing
            # to a file (not a pipe) keeps data offsets, so a filtered restore can seek.
            _tool(
                pg_dump,
                [
                    "--format=custom",
                    "--no-owner",
                    "--no-privileges",
                    f"--snapshot={snapshot_id}",
                    f"--file={dump}",
                ],
            )
            snap.rollback()
            writer = bundle.BundleWriter(output)
            writer.add_file(bundle.DUMP, dump)
            dump.unlink()
            recipes = settings.SPECMATE_APPROVED_RECIPES
            writer.add_bytes(
                bundle.RECIPES, (json.dumps(recipes, indent=2, sort_keys=True) + "\n").encode()
            )
            if secrets_env is not None:
                writer.add_bytes(bundle.SECRETS, secrets_env)
            present: dict[str, int] = {}
            total = 0
            for sha256, path in _stored_blobs():
                entry = writer.add_file(bundle.blob_member(sha256), path, expected_sha256=sha256)
                present[sha256] = entry.size
                total += entry.size
            missing = sorted(sha for sha, size in state["references"] if present.get(sha) != size)
            if missing:
                raise BackupError(
                    f"{len(missing)} recorded byte objects are missing or damaged in the "
                    f"artifact store (first: {missing[:3]}); the backup is incomplete."
                )
            referenced = {sha for sha, _ in state["references"]}
            manifest = writer.finish(
                {
                    "backup_id": str(uuid.uuid4()),
                    "created_at": timezone.now().isoformat(),
                    "installation_id": state["installation_id"],
                    "application": {
                        "version": _app_version(),
                        "migrations": state["migrations"],
                    },
                    "database": {
                        "server_version": state["server_version"],
                        "dump_tool": dump_tool,
                        "consistency": "exported_repeatable_read_snapshot",
                    },
                    "artifacts": {
                        "blobs": len(present),
                        "bytes": total,
                        "referenced": len(referenced),
                        "unreferenced": len(set(present) - referenced),
                    },
                    "work_at_backup": {
                        "mode": state["mode"],
                        "open_stages": state["open_stages"],
                        "undelivered_dispatch": state["undelivered"],
                        "usable_runner_credentials": state["usable_credentials"],
                    },
                    "recipes": {"approved_ids": sorted(recipes)},
                    "secrets": {"included": secrets_env is not None},
                    "workflow_engine": {
                        "included": False,
                        "reason": "Workflows carry identifiers only; build stages, receipts "
                        "and dispatch state are restored from the application database.",
                    },
                }
            )
    return manifest


# ---- restore -----------------------------------------------------------------------------


def require_empty_target() -> None:
    """Restore never overwrites, merges or resets: database and byte store must be empty."""
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg_toast%%' AND n.nspname NOT LIKE 'pg_temp%%'
              AND NOT EXISTS (
                  SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
              )
            """
        )
        if cur.fetchone()[0]:
            raise BackupError(
                "The target database is not empty. Restore only into a new, empty database; "
                "this command never deletes existing state."
            )
    base = blobstore.root() / "blobs"
    if base.exists() and any(p.is_file() for p in base.rglob("*")):
        raise BackupError("The target artifact store already holds bytes; use an empty one.")


EXTENSION_ENTRY = re.compile(r"^\d+;\s+\d+\s+\d+\s+(?:EXTENSION - |COMMENT - EXTENSION )(\S+)")


def _restore_list(pg_restore: str, dump: Path, target: Path) -> Path:
    """Restore everything except extension objects, which the target already provides.

    Extensions are created by the installation's database initialization as a privileged
    role; the application role can neither own nor comment on them. A missing extension
    is refused here rather than half-restored.
    """
    entries = _tool(pg_restore, ["--list", str(dump)], connect=False).decode()
    kept, required = [], set()
    for line in entries.splitlines():
        match = EXTENSION_ENTRY.match(line)
        if match is None:
            kept.append(line)
        elif " EXTENSION - " in line:
            required.add(match.group(1))
    with connection.cursor() as cur:
        cur.execute("SELECT extname FROM pg_extension")
        present = {row[0] for row in cur.fetchall()}
    missing = sorted(required - present)
    if missing:
        raise BackupError(
            f"The target database lacks extensions {missing}; create the database with the "
            "installation's PostgreSQL initialization before restoring."
        )
    target.write_text("\n".join(kept) + "\n")
    return target


def require_same_version(manifest: dict[str, Any]) -> None:
    recorded = set(manifest.get("application", {}).get("migrations", []))
    current = set(code_migrations())
    if recorded != current:
        raise BackupError(
            "This backup was taken by a different application version "
            f"(only in backup: {sorted(recorded - current)[:5]}, "
            f"only in this version: {sorted(current - recorded)[:5]}). "
            "Restore with the same version, then upgrade with its migrations."
        )


def fence(*, backup_id: str) -> dict[str, Any]:
    """Make restored state inert: nothing captured in the backup runs or dispatches again."""
    from specmate.builds.operations import _cancel, _event, _save
    from specmate.diagnostics.operations import _control, _transition

    now = timezone.now()
    with transaction.atomic():
        installation = Installation.objects.select_related("owner").get(singleton=True)
        if installation.owner is None:
            raise BackupError("The restored installation has no owner; the restore is invalid.")
        revoked = RunnerCredential.objects.filter(revoked_at__isnull=True).update(revoked_at=now)
        withheld = BuildOutbox.objects.filter(
            delivered_at__isnull=True, withheld_at__isnull=True
        ).update(withheld_at=now, withheld_reason=RESTORE_REASON)
        cancelled = interrupted = 0
        for stage in BuildStage.objects.select_for_update().filter(state__in=PENDING + ACTIVE):
            if stage.state in PENDING:
                _cancel(stage, RESTORE_REASON)
                cancelled += 1
            else:
                # The outcome after the backup point is unknown; it is never re-run here.
                previous = stage.state
                stage.state = "interrupted"
                _save(stage)
                _event(stage, RESTORE_REASON, previous_state=previous)
                interrupted += 1
        already = BuildStage.objects.filter(state="interrupted").count() - interrupted
        detail = {
            "backup_id": backup_id,
            "runner_credentials_revoked": revoked,
            "dispatch_withheld": withheld,
            "stages_cancelled_before_start": cancelled,
            "stages_interrupted": interrupted,
            "stages_already_interrupted": already,
        }
        control = _control()
        _transition(
            control,
            WorkControl.Mode.MAINTENANCE,
            f"restored from backup {backup_id}",
            installation.owner,
            detail,
        )
    return {**detail, "mode": WorkControl.Mode.MAINTENANCE.value}


def _place_blobs(verified: bundle.Verified) -> int:
    placed = 0
    for entry in verified.blobs():
        target = blobstore.blob_path(entry.sha256)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        source = verified.path(entry.path)
        source.chmod(0o444)
        try:
            os.replace(source, target)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            # Staging on another filesystem: copy beside the target, then rename atomically.
            partial = target.with_name(f".{target.name}.partial")
            shutil.copyfile(source, partial)
            partial.chmod(0o444)
            os.replace(partial, target)
        placed += 1
    return placed


def _verify_references() -> int:
    checked = 0
    for model in REFERENCES:
        for sha256, size in model.objects.values_list("sha256", "size").distinct():
            try:
                actual = blobstore.blob_path(sha256).stat().st_size
            except FileNotFoundError:
                actual = None
            if actual != size:
                raise BackupError(f"Restored bytes for {sha256} are missing or damaged.")
            checked += 1
    return checked


def restore_backup(stream: IO[bytes], *, staging_parent: Path | None = None) -> dict[str, Any]:
    root = blobstore.root()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if marker.restore_in_progress():
        raise BackupError(
            "An earlier restore into this target did not finish. Start again with a new, "
            "empty database and artifact store; partial state is never resumed."
        )
    require_empty_target()
    pg_restore = settings.SPECMATE_PG_RESTORE
    restore_tool = _tool_version(pg_restore)
    parent = staging_parent or root / "staging"
    staging = parent / f"restore-{uuid.uuid4()}"
    try:
        try:
            verified = bundle.read_bundle(stream, staging)
        except bundle.BundleError as exc:
            raise BackupError(f"Backup bundle rejected: {exc}") from None
        manifest = verified.manifest
        require_same_version(manifest)
        require_empty_target()
        toc = _restore_list(pg_restore, verified.path(bundle.DUMP), staging / "restore.list")
        # From here on the target is not usable until this command finishes successfully.
        fd = os.open(marker.path(), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(
                {"backup_id": manifest["backup_id"], "started_at": timezone.now().isoformat()}, out
            )
        _tool(
            pg_restore,
            [
                "--exit-on-error",
                "--single-transaction",
                "--no-owner",
                "--no-privileges",
                f"--use-list={toc}",
                str(verified.path(bundle.DUMP)),
            ],
        )
        connection.close()
        fenced = fence(backup_id=manifest["backup_id"])
        placed = _place_blobs(verified)
        checked = _verify_references()
        installation_id = str(Installation.objects.get(singleton=True).installation_id)
        if installation_id != manifest["installation_id"]:
            raise BackupError("Restored installation identity does not match the manifest.")
        marker.path().unlink()
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    target_recipes = sorted(settings.SPECMATE_APPROVED_RECIPES)
    return {
        "restored": True,
        "backup_id": manifest["backup_id"],
        "manifest_sha256": verified.manifest_sha256,
        "installation_id": installation_id,
        "restore_tool": restore_tool,
        "work": fenced,
        "artifacts": {"restored_blobs": placed, "referenced_verified": checked},
        "execution": {
            "enabled": False,
            "runner_credentials_usable": 0,
            "target_approved_recipes": target_recipes,
            "backup_approved_recipes": manifest.get("recipes", {}).get("approved_ids", []),
        },
        "secrets_in_bundle": manifest.get("secrets", {}).get("included", False),
        "workflow_engine": "not restored; restored work is fenced and never re-dispatched",
    }
