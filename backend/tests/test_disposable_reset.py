"""OPS-007: resets only inside a verified disposable installation."""

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError

from specmate.operations import disposable

BACKEND = Path(__file__).resolve().parents[1]
SCRATCH_DB = "specmate_ops_disposable_scratch"


def _marker(tmp_path, **over):
    root = tmp_path / "state" / "disposable"
    db = settings.DATABASES["default"]
    data = {
        "schema": 1,
        "policy": "pre-1.0-disposable",
        "installation_id": str(uuid.uuid4()),
        "database": {"host": db["HOST"], "port": db["PORT"], "name": db["NAME"]},
        "state_root": str(root),
        "artifact_root": str(root / "artifacts"),
    }
    data.update(over)
    path = tmp_path / "marker.json"
    path.write_text(json.dumps(data))
    return path, data


@pytest.fixture
def aligned(settings, tmp_path):
    """Point the artifact root at a marked location; the pytest DB stays untouched."""
    path, data = _marker(tmp_path)
    settings.SPECMATE_ARTIFACT_ROOT = data["artifact_root"]
    return path, data


def _refused(path, match):
    with pytest.raises(disposable.ResetRefused, match=match):
        disposable.verify(str(path))


@pytest.mark.django_db
def test_verify_refuses_unknown_targets(aligned, tmp_path, settings):
    path, data = aligned
    _refused(tmp_path / "missing.json", "missing")
    link = tmp_path / "link.json"
    link.symlink_to(path)
    _refused(link, "regular file")
    bad = tmp_path / "bad.json"
    bad.write_text("{nope")
    _refused(bad, "unreadable")
    for over, match in [
        ({"policy": "production"}, "pre-1.0"),
        ({"database": {**data["database"], "name": "other"}}, "database name"),
        ({"database": {**data["database"], "host": "elsewhere"}}, "database host"),
        ({"installation_id": "x"}, "UUID"),
        ({"state_root": "/"}, "too broad"),
        ({"state_root": "relative/x"}, "absolute"),
        ({"artifact_root": data["state_root"]}, "strictly inside"),
        ({"artifact_root": str(tmp_path / "state" / "disposable" / "a" / ".." / "b")}, "links"),
    ]:
        other, _ = _marker(tmp_path, **over)
        _refused(other, match)
    # configured artifact root differing from the marker
    path, _ = _marker(tmp_path)
    settings.SPECMATE_ARTIFACT_ROOT = str(tmp_path / "state" / "disposable" / "elsewhere")
    _refused(path, "artifact root")


@pytest.mark.django_db
def test_debug_or_development_alone_is_insufficient(settings, aligned):
    settings.DEVELOPMENT = True
    settings.DEBUG = True
    with pytest.raises(disposable.ResetRefused, match="No installation marker"):
        disposable.verify("")
    # Not being a development environment no longer blocks a verified marker.
    settings.DEVELOPMENT = False
    settings.DEBUG = False
    from specmate.access.models import Installation

    path, data = aligned
    Installation.objects.update_or_create(
        singleton=True, defaults={"installation_id": data["installation_id"]}
    )
    assert str(disposable.verify(str(path)).installation_id) == data["installation_id"]


@pytest.mark.django_db
def test_installation_identity_must_match(aligned):
    from specmate.access.models import Installation

    path, data = aligned
    Installation.objects.get_or_create(singleton=True)
    _refused(path, "installation ID")
    Installation.objects.filter(singleton=True).update(installation_id=data["installation_id"])
    assert str(disposable.verify(str(path)).installation_id) == data["installation_id"]


@pytest.mark.django_db
def test_command_requires_confirmation_and_check_changes_nothing(aligned):
    from specmate.access.models import Installation

    path, data = aligned
    Installation.objects.update_or_create(
        singleton=True, defaults={"installation_id": data["installation_id"]}
    )
    call_command("reset_disposable", marker=str(path), check=True)
    with pytest.raises(CommandError, match="--confirm"):
        call_command("reset_disposable", marker=str(path))
    with pytest.raises(CommandError, match="--confirm"):
        call_command("reset_disposable", marker=str(path), confirm=str(uuid.uuid4()))
    assert Installation.objects.filter(singleton=True).exists()


@pytest.mark.django_db
def test_active_work_blocks_reset(aligned):
    from datetime import timedelta

    from django.contrib.auth import get_user_model
    from django.utils import timezone

    from specmate.access.models import Installation, Workspace
    from specmate.builds.models import RunnerCredential

    path, data = aligned
    Installation.objects.update_or_create(
        singleton=True, defaults={"installation_id": data["installation_id"]}
    )
    disposable.assert_quiescent()
    user = get_user_model().objects.create_user(username="ops7", password=None)
    RunnerCredential.objects.create(
        name="c",
        workspace=Workspace.objects.create(name="w"),
        recipe_ids=[],
        token_sha256="a" * 64,
        expires_at=timezone.now() + timedelta(hours=1),
        created_by=user,
    )
    with pytest.raises(CommandError, match="runner credentials"):
        call_command("reset_disposable", marker=str(path), confirm=data["installation_id"])


def test_clear_artifact_root_stays_inside_and_does_not_follow_links(tmp_path):
    root = tmp_path / "state" / "d" / "artifacts"
    outside = tmp_path / "outside"
    outside.mkdir()
    keep = outside / "keep.txt"
    keep.write_text("x")
    (root / "ab").mkdir(parents=True)
    (root / "ab" / "blob").write_text("y")
    (root / "top").write_text("z")
    (root / "link").symlink_to(outside)
    v = disposable.Verified(uuid.uuid4(), "db", root.parent, root, True)
    assert disposable.clear_artifact_root(v) == 3
    assert list(root.iterdir()) == [] and keep.read_text() == "x"
    swapped = tmp_path / "state" / "d" / "swapped"
    swapped.symlink_to(outside)
    with pytest.raises(disposable.ResetRefused):
        disposable.clear_artifact_root(
            disposable.Verified(uuid.uuid4(), "db", root.parent, swapped, True)
        )
    assert keep.read_text() == "x"


def _scratch_env(tmp_path, marker=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("SPECMATE_DISPOSABLE")}
    env.update(
        SPECMATE_DB_NAME=SCRATCH_DB,
        SPECMATE_ENVIRONMENT="development",
        SPECMATE_ARTIFACT_ROOT=str(tmp_path / "state" / "disposable" / "artifacts"),
        DJANGO_SETTINGS_MODULE="specmate.settings",
    )
    if marker:
        env["SPECMATE_DISPOSABLE_MARKER"] = str(marker)
    return env


def _installation_id(conn):
    return str(conn.execute("SELECT installation_id FROM access_installation").fetchone()[0])


def _manage(env, *args):
    return subprocess.run(  # noqa: S603
        [sys.executable, "manage.py", *args], cwd=BACKEND, env=env, capture_output=True, text=True
    )


@pytest.fixture
def scratch_db():
    db = settings.DATABASES["default"]
    kw = dict(host=db["HOST"], port=db["PORT"], user=db["USER"], password=db["PASSWORD"])
    with psycopg.connect(dbname="postgres", autocommit=True, **kw) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{SCRATCH_DB}"')
    yield kw
    with psycopg.connect(dbname="postgres", autocommit=True, **kw) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}" WITH (FORCE)')


def test_end_to_end_reset_in_declared_install_and_refusal_elsewhere(scratch_db, tmp_path):
    db = settings.DATABASES["default"]
    marker_id = str(uuid.uuid4())
    root = tmp_path / "state" / "disposable"
    marker = tmp_path / "marker.json"
    marker.write_text(
        json.dumps(
            {
                "schema": 1,
                "policy": "pre-1.0-disposable",
                "installation_id": marker_id,
                "database": {"host": db["HOST"], "port": db["PORT"], "name": SCRATCH_DB},
                "state_root": str(root),
                "artifact_root": str(root / "artifacts"),
            }
        )
    )
    env = _scratch_env(tmp_path, marker)
    # Fresh empty target: verifies and builds the baseline with the marker identity.
    done = _manage(env, "reset_disposable", "--confirm", marker_id)
    assert done.returncode == 0, done.stderr
    kw = {**scratch_db, "dbname": SCRATCH_DB}
    with psycopg.connect(**kw) as conn:
        assert (
            str(conn.execute("SELECT installation_id FROM access_installation").fetchone()[0])
            == marker_id
        )
        conn.execute("CREATE TABLE leftover_state (x int)")
        conn.commit()
    (root / "artifacts" / "ab").mkdir(parents=True)
    (root / "artifacts" / "ab" / "blob").write_text("b")
    sibling = root / "other-service"
    sibling.mkdir()
    (sibling / "keep").write_text("k")

    wrong = _manage(env, "reset_disposable", "--confirm", str(uuid.uuid4()))
    assert wrong.returncode != 0 and "refused" in wrong.stderr
    assert (root / "artifacts" / "ab" / "blob").exists()

    again = _manage(env, "reset_disposable", "--confirm", marker_id)
    assert again.returncode == 0, again.stderr
    with psycopg.connect(**kw) as conn:
        assert conn.execute("SELECT to_regclass('public.leftover_state')").fetchone()[0] is None
        assert (
            str(conn.execute("SELECT installation_id FROM access_installation").fetchone()[0])
            == marker_id
        )
    assert list((root / "artifacts").iterdir()) == []
    assert (sibling / "keep").read_text() == "k"

    # Same database without a marker, with production environment, or with a foreign marker.
    no_marker = _scratch_env(tmp_path)
    assert _manage(no_marker, "reset_disposable", "--confirm", marker_id).returncode != 0
    # The environment name is not authority: a verified marker also resets under production.
    prod = {**env, "SPECMATE_ENVIRONMENT": "production", "SPECMATE_SECRET_KEY": "x"}
    assert _manage(prod, "reset_disposable", "--confirm", marker_id).returncode == 0
    data = json.loads(marker.read_text())
    data["installation_id"] = str(uuid.uuid4())
    marker.write_text(json.dumps(data))
    foreign = _manage(env, "reset_disposable", "--confirm", data["installation_id"])
    assert foreign.returncode != 0 and "installation ID" in foreign.stderr
    with psycopg.connect(**kw) as conn:
        assert conn.execute("SELECT count(*) FROM access_installation").fetchone()[0] == 1
