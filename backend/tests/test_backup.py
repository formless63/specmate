# ruff: noqa: F811
"""OPS-006: coordinated backup bundles and same-version restore without side-effect replay."""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import uuid
from pathlib import Path

import psycopg
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection

from specmate.backups import bundle, marker
from specmate.backups.service import (
    BackupError,
    code_migrations,
    fence,
    require_same_version,
    restore_backup,
)
from specmate.builds.dispatch import ack_outbox, ready_outbox
from specmate.builds.models import BuildOutbox, BuildStage, RunnerCredential
from specmate.builds.operations import authenticate_runner
from specmate.diagnostics.guards import InstallationNotAccepting, leasing_allowed
from specmate.diagnostics.models import WorkControl, WorkControlEvent
from specmate.operations import Conflict, Context, execute
from specmate.operations.startup import initialize, schema_ready

from .conftest import op
from .test_diagnostics import (  # noqa: F401 - shared fixtures
    RIGHTS,
    build,
    credential,
    internal,
    operator,
    recipe,
    request_one,
    runner_op,
    source,
    state_token,
    status,
)

BACKEND = Path(__file__).resolve().parents[1]
OUTPUT = b"synthetic generated output\n"


def digest(data):
    return hashlib.sha256(data).hexdigest()


# ---- bundle format (standard library only) ---------------------------------------------


def write_bundle(tmp_path, *, blobs=(b"alpha\n",), secrets=b"SPECMATE_SECRET_KEY=s\n", extra=None):
    dump = tmp_path / "dump.bin"
    dump.write_bytes(b"synthetic dump bytes")
    out = io.BytesIO()
    writer = bundle.BundleWriter(out)
    writer.add_file(bundle.DUMP, dump)
    writer.add_bytes(bundle.RECIPES, b'{"synthetic-r1": {}}\n')
    if secrets is not None:
        writer.add_bytes(bundle.SECRETS, secrets)
    for data in blobs:
        path = tmp_path / digest(data)
        path.write_bytes(data)
        writer.add_file(bundle.blob_member(digest(data)), path, expected_sha256=digest(data))
    manifest = {"backup_id": "b1", "installation_id": "i1", **(extra or {})}
    writer.finish(manifest)
    return out.getvalue()


def read(data, tmp_path):
    return bundle.read_bundle(io.BytesIO(data), tmp_path / f"stage-{uuid.uuid4()}")


def rebuild(data, change):
    """Rewrite a bundle's members through ``change(name, bytes) -> bytes | None``."""
    src = tarfile.open(fileobj=io.BytesIO(data))
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as dst:
        for member in src.getmembers():
            payload = change(member.name, src.extractfile(member).read())
            if payload is None:
                continue
            member.size = len(payload)
            dst.addfile(member, io.BytesIO(payload))
    return out.getvalue()


def test_bundle_round_trip_lists_every_member_by_hash(tmp_path):
    verified = read(write_bundle(tmp_path), tmp_path)
    assert verified.manifest["format"] == bundle.FORMAT
    paths = {f["path"] for f in verified.manifest["files"]}
    assert paths == {
        bundle.DUMP,
        bundle.RECIPES,
        bundle.SECRETS,
        bundle.blob_member(digest(b"alpha\n")),
    }
    assert verified.path(bundle.blob_member(digest(b"alpha\n"))).read_bytes() == b"alpha\n"
    assert bundle.summary(verified)["secrets_included"] is True


@pytest.mark.parametrize(
    "change",
    [
        # altered dump bytes
        lambda n, b: b + b"x" if n == bundle.DUMP else b,
        # dropped artifact bytes
        lambda n, b: None if n.startswith("blobs/") else b,
        # no manifest at all (truncated stream)
        lambda n, b: None if n.startswith("manifest") else b,
        # manifest edited without its digest
        lambda n, b: b.replace(b'"b1"', b'"b2"') if n == bundle.MANIFEST else b,
    ],
    ids=["altered", "missing-blob", "no-manifest", "manifest-edited"],
)
def test_altered_or_incomplete_bundles_are_rejected(tmp_path, change):
    with pytest.raises(bundle.BundleError):
        read(rebuild(write_bundle(tmp_path), change), tmp_path)


def test_unlisted_or_traversing_members_are_rejected(tmp_path):
    data = write_bundle(tmp_path)
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as dst:
        info = tarfile.TarInfo("../escape")
        info.size = 1
        dst.addfile(info, io.BytesIO(b"x"))
    # A valid-looking member that the manifest does not list is rejected too.
    extra = io.BytesIO()
    with (
        tarfile.open(fileobj=io.BytesIO(data)) as src,
        tarfile.open(fileobj=extra, mode="w") as dst,
    ):
        for member in src.getmembers():
            dst.addfile(member, src.extractfile(member))
        info = tarfile.TarInfo(bundle.blob_member(digest(b"unlisted\n")))
        info.size = len(b"unlisted\n")
        dst.addfile(info, io.BytesIO(b"unlisted\n"))
    for bad in (out.getvalue(), extra.getvalue()):
        with pytest.raises(bundle.BundleError):
            read(bad, tmp_path)
    assert not (tmp_path.parent / "escape").exists()
    # A blob whose name is not its content is rejected even if the manifest agrees.
    wrong = digest(b"other\n")
    path = tmp_path / "wrong"
    path.write_bytes(b"alpha\n")
    writer = bundle.BundleWriter(io.BytesIO())
    with pytest.raises(bundle.BundleError):
        writer.add_file(bundle.blob_member(wrong), path, expected_sha256=wrong)


def test_extract_config_recovers_secrets_and_starts_with_an_empty_registry(tmp_path):
    data = write_bundle(tmp_path)
    archive = tmp_path / "b.tar"
    archive.write_bytes(data)
    target = tmp_path / "stack"
    argv = ["extract-config", "--input", str(archive), "--output-dir", str(target)]
    assert bundle.main(argv) == 0
    assert (target / ".env").read_bytes() == b"SPECMATE_SECRET_KEY=s\n"
    assert (target / ".env").stat().st_mode & 0o777 == 0o600
    assert (target / "recipes.json").read_text() == "{}\n"
    assert json.loads((target / "recipes.restored.json").read_text()) == {"synthetic-r1": {}}
    # Existing secrets are never overwritten.
    assert bundle.main(argv) == 1
    assert (target / ".env").read_bytes() == b"SPECMATE_SECRET_KEY=s\n"
    no_secrets = tmp_path / "n.tar"
    no_secrets.write_bytes(write_bundle(tmp_path, secrets=None))
    assert (
        bundle.main(
            ["extract-config", "--input", str(no_secrets), "--output-dir", str(tmp_path / "other")]
        )
        == 1
    )


# ---- restore preconditions -------------------------------------------------------------


def test_restore_refuses_a_non_empty_target_without_touching_it(db, tmp_path, artifact_root):
    data = write_bundle(tmp_path, extra={"application": {"migrations": code_migrations()}})
    with pytest.raises(BackupError, match="not empty"):
        restore_backup(io.BytesIO(data))
    assert not marker.path().exists()
    assert not (artifact_root / "blobs").exists()


def test_restore_requires_the_same_application_schema():
    require_same_version({"application": {"migrations": code_migrations()}})
    with pytest.raises(BackupError, match="different application version"):
        require_same_version({"application": {"migrations": code_migrations()[:-1]}})
    with pytest.raises(BackupError):
        require_same_version({"application": {"migrations": [*code_migrations(), "x.0001_y"]}})


def test_an_unfinished_restore_blocks_startup_and_never_migrates(db):
    assert schema_ready() is False  # no installation row yet in this test database
    marker.path().parent.mkdir(parents=True, exist_ok=True)
    marker.path().write_text("{}")
    with pytest.raises(CommandError, match="restore is in progress"):
        initialize(timeout=0)
    with pytest.raises(BackupError, match="did not finish"):
        restore_backup(io.BytesIO(b""))


# ---- fencing restored state ------------------------------------------------------------


def test_fence_disables_execution_and_withholds_dispatch_without_replay(
    users, project, request_one, credential, operator
):
    done, active, waiting = request_one(), request_one(), request_one()
    op(users["owner"], "build.dispatch", {"build_id": active["build_id"]})
    lease = runner_op(credential, "runner.lease")["lease"]
    assert lease["build_id"] == active["build_id"]
    BuildStage.objects.filter(build_id=done["build_id"]).update(
        state="failed", receipt={"outcome": "failed"}
    )
    ack_outbox(BuildOutbox.objects.get(build_id=done["build_id"]).id)
    queued = request_one()
    op(users["owner"], "build.dispatch", {"build_id": queued["build_id"]})

    report = fence(backup_id="synthetic-backup")

    assert report["runner_credentials_revoked"] == 1
    assert report["dispatch_withheld"] == 3
    assert report["stages_cancelled_before_start"] == 2
    assert report["stages_interrupted"] == 1
    states = dict(BuildStage.objects.values_list("build_id", "state"))
    assert {str(k): v for k, v in states.items()} == {
        done["build_id"]: "failed",
        active["build_id"]: "interrupted",
        waiting["build_id"]: "cancelled",
        queued["build_id"]: "cancelled",
    }
    receipt = BuildStage.objects.get(build_id=waiting["build_id"]).receipt
    assert receipt == {
        "outcome": "cancelled",
        "reason": "restored_from_backup",
        "execution_started": False,
    }
    assert BuildOutbox.objects.filter(delivered_at__isnull=False).count() == 1
    assert not RunnerCredential.objects.filter(revoked_at__isnull=True).exists()
    control = WorkControl.objects.get()
    assert control.mode == "maintenance"
    event = WorkControlEvent.objects.get(to_mode="maintenance")
    assert event.detail["backup_id"] == "synthetic-backup"

    # Nothing dispatches, leases or is accepted while in maintenance.
    assert ready_outbox() == []
    assert leasing_allowed() is False
    with pytest.raises(InstallationNotAccepting):
        request_one()
    with pytest.raises(Conflict, match="post-restore maintenance"):
        internal(
            operator,
            "installation.safe_stop",
            {"mode": "drain", "reason": "x"},
            expected_state=state_token(),
        )
    # A restored runner credential no longer authenticates at all.
    assert authenticate_runner(credential["token"]) is None
    report = status(users["viewer"], project)
    assert "installation_maintenance" in {f["code"] for f in report["findings"]}
    assert report["dispatch"]["undelivered"] == 0
    assert report["work"]["accepting_new_work"] is False

    # Even after an explicit resume, withheld work is never delivered or restarted.
    internal(operator, "installation.resume", {}, expected_state=state_token())
    assert ready_outbox() == []
    assert BuildStage.objects.get(build_id=active["build_id"]).state == "interrupted"
    fresh = request_one()
    assert [str(d.build_id) for d in ready_outbox()] == [fresh["build_id"]]


@pytest.mark.django_db(transaction=True)
def test_backup_refuses_when_recorded_bytes_are_missing(
    users, source, operator, artifact_root, tmp_path
):
    for blob in (artifact_root / "blobs").rglob("*"):
        if blob.is_file():
            blob.chmod(0o644)
            blob.unlink()
    archive = tmp_path / "backup.tar"
    with pytest.raises(CommandError, match="missing or damaged"):
        call_command("backup", "create", "--output", str(archive), "--without-secrets")
    assert not archive.exists() and not Path(f"{archive}.partial").exists()


def test_backup_requires_an_owned_installation_and_explicit_secret_choice(db, tmp_path):
    with pytest.raises(CommandError):
        call_command("backup", "create", "--output", str(tmp_path / "x.tar"))
    with pytest.raises(CommandError, match="owner"):
        call_command("backup", "create", "--output", str(tmp_path / "x.tar"), "--without-secrets")


# ---- actual pg_dump/pg_restore round trip ----------------------------------------------

PG_DUMP = os.environ.get("SPECMATE_TEST_PG_DUMP") or shutil.which("pg_dump")
PG_RESTORE = os.environ.get("SPECMATE_TEST_PG_RESTORE") or shutil.which("pg_restore")
needs_pg_tools = pytest.mark.skipif(
    not (PG_DUMP and PG_RESTORE),
    reason="PostgreSQL client tools matching the server are required "
    "(SPECMATE_TEST_PG_DUMP / SPECMATE_TEST_PG_RESTORE)",
)


def _admin(dbname):
    s = connection.settings_dict
    return psycopg.connect(
        host=s["HOST"],
        port=s["PORT"],
        user=s["USER"],
        password=s["PASSWORD"],
        dbname=dbname,
        autocommit=True,
    )


def _rows(conn, table):
    return conn.execute(
        f"SELECT coalesce(json_agg(t ORDER BY t::text), '[]') FROM \"{table}\" t"
    ).fetchone()[0]


def _manage(env, *args, stdin=None):
    return subprocess.run(  # noqa: S603 - this interpreter and a fixed command
        [sys.executable, "manage.py", *args],
        cwd=BACKEND,
        env=env,
        stdin=stdin,
        capture_output=True,
        check=False,
        timeout=600,
    )


@needs_pg_tools
@pytest.mark.django_db(transaction=True)
def test_same_version_restore_into_empty_state_keeps_exact_bytes_and_disables_execution(
    users, project, request_one, credential, operator, settings, tmp_path, artifact_root
):
    settings.SPECMATE_PG_DUMP = PG_DUMP
    settings.SPECMATE_PG_RESTORE = PG_RESTORE
    finished = request_one()
    op(users["owner"], "build.dispatch", {"build_id": finished["build_id"]})
    lease = runner_op(credential, "runner.lease")["lease"]
    fenced = {"stage_id": lease["stage_id"], "fencing_token": lease["fencing_token"]}
    upload_output(credential, lease)
    runner_op(
        credential,
        "runner.complete",
        {
            **fenced,
            "outcome": "succeeded",
            "exit_code": 0,
            "outputs": [{"path": "result.txt", "sha256": digest(OUTPUT)}],
        },
    )
    ack_outbox(BuildOutbox.objects.get(build_id=finished["build_id"]).id)
    active = request_one()
    op(users["owner"], "build.dispatch", {"build_id": active["build_id"]})
    runner_op(credential, "runner.lease")
    waiting = request_one()

    archive = tmp_path / "backup.tar"
    with pytest.raises(CommandError, match="Unfinished build work"):
        call_command("backup", "create", "--output", str(archive), "--without-secrets")
    assert not archive.exists() and not Path(f"{archive}.partial").exists()
    env_file = tmp_path / "installation.env"
    env_file.write_text("SPECMATE_SECRET_KEY=synthetic\n")
    call_command(
        "backup",
        "create",
        "--output",
        str(archive),
        "--secrets-env",
        str(env_file),
        "--allow-active-work",
        stderr=io.StringIO(),
    )
    with pytest.raises(CommandError, match="never overwritten"):
        call_command(
            "backup", "create", "--output", str(archive), "--without-secrets", "--allow-active-work"
        )
    verified = read(archive.read_bytes(), tmp_path)
    manifest = verified.manifest
    assert manifest["work_at_backup"]["open_stages"] == {"leased": 1, "waiting_dispatch": 1}
    assert manifest["work_at_backup"]["undelivered_dispatch"] == 2
    assert manifest["secrets"]["included"] is True
    assert manifest["artifacts"]["referenced"] == 2  # the source and the generated output

    source_db = connection.settings_dict["NAME"]
    target_db = f"{source_db}_restore_{uuid.uuid4().hex[:8]}"
    target_root = tmp_path / "target-artifacts"
    with _admin(source_db) as admin:
        tables = [
            r[0]
            for r in admin.execute(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"
            )
        ]
        before = {t: _rows(admin, t) for t in tables}
        admin.execute(f'CREATE DATABASE "{target_db}"')
    env = {
        **os.environ,
        "DJANGO_SETTINGS_MODULE": "tests.settings",
        "SPECMATE_DB_NAME": target_db,
        "SPECMATE_ARTIFACT_ROOT": str(target_root),
        "SPECMATE_PG_DUMP": PG_DUMP,
        "SPECMATE_PG_RESTORE": PG_RESTORE,
        "SPECMATE_APPROVED_RECIPES": "{}",
    }
    try:
        with archive.open("rb") as stdin:
            result = _manage(env, "backup", "restore", "--input", "-", stdin=stdin)
        assert result.returncode == 0, result.stderr.decode()[-3000:]
        report = json.loads(result.stderr.decode()[result.stderr.decode().index("{") :])
        assert report["execution"]["enabled"] is False
        assert report["work"]["dispatch_withheld"] == 2
        assert report["work"]["stages_interrupted"] == 1
        assert report["work"]["stages_cancelled_before_start"] == 1
        assert report["artifacts"]["referenced_verified"] == 2

        with _admin(target_db) as restored:
            fenced_tables = {
                "builds_buildstage",
                "builds_buildoutbox",
                "builds_runnercredential",
                "builds_stageevent",
                "diagnostics_workcontrol",
                "diagnostics_workcontrolevent",
            }
            for table in tables:
                if table not in fenced_tables:
                    assert _rows(restored, table) == before[table], table
            # Every recorded source and artifact byte is retrievable with its exact hash.
            for table in ("sources_sourceblob", "builds_stageoutput"):
                for sha256, size in restored.execute(
                    f'SELECT sha256, size FROM "{table}"'
                ).fetchall():
                    path = target_root / "blobs" / "sha256" / sha256[:2] / sha256[2:4] / sha256
                    assert path.stat().st_size == size
                    assert digest(path.read_bytes()) == sha256
            assert (
                restored.execute("SELECT mode FROM diagnostics_workcontrol").fetchone()[0]
                == "maintenance"
            )
            assert (
                restored.execute(
                    "SELECT count(*) FROM builds_runnercredential WHERE revoked_at IS NULL"
                ).fetchone()[0]
                == 0
            )
            assert (
                restored.execute(
                    "SELECT count(*) FROM builds_buildoutbox "
                    "WHERE delivered_at IS NULL AND withheld_at IS NULL"
                ).fetchone()[0]
                == 0
            )
            assert dict(
                restored.execute("SELECT build_id::text, state FROM builds_buildstage").fetchall()
            ) == {
                finished["build_id"]: "succeeded",
                active["build_id"]: "interrupted",
                waiting["build_id"]: "cancelled",
            }
        assert not (target_root / marker.NAME).exists()
        assert not any((target_root / "staging").iterdir())
        # The restored application is schema-ready, reports maintenance, and refuses a
        # second restore into the now non-empty target.
        assert _manage(env, "startup", "--check", "--timeout", "0").returncode == 0
        diagnosis = _manage(env, "work_control", "diagnose")
        assert diagnosis.returncode == 0, diagnosis.stderr.decode()[-2000:]
        installation = json.loads(diagnosis.stdout)
        assert installation["work"]["mode"] == "maintenance"
        assert installation["runner"]["credentials_usable"] == 0
        assert installation["storage"]["state"] == "available"
        with archive.open("rb") as stdin:
            again = _manage(env, "backup", "restore", "--input", "-", stdin=stdin)
        assert again.returncode != 0 and b"not empty" in again.stderr
    finally:
        with _admin(source_db) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{target_db}" WITH (FORCE)')


def upload_output(credential, lease):
    return execute(
        "runner.output",
        Context(
            user=authenticate_runner(credential["token"]),
            via="api",
            request_id="out",
            attachments={"content": io.BytesIO(OUTPUT)},
        ),
        {
            "stage_id": lease["stage_id"],
            "fencing_token": lease["fencing_token"],
            "path": "result.txt",
            "sha256": digest(OUTPUT),
            "size": len(OUTPUT),
            "media_type": "text/plain",
            "rights": RIGHTS,
            "source_revision_id": lease["source_revision_id"],
        },
    ).result
