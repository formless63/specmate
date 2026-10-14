"""OPS-002: Temporal startup scripts, run with stubbed tools on PATH (no real Temporal)."""

import os
import shutil
import stat
import subprocess
import time
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"

STUBS = {
    # Plays the part of psql: runs the script's `\!` shell escape and reports its status,
    # as psql does with ON_ERROR_STOP, and records the connection it was given.
    "psql": r"""#!/bin/bash
echo "psql db=$PGDATABASE user=$PGUSER" >> "$STUB_LOG"
cat > "$STUB_STDIN"
grep -q pg_advisory_lock "$STUB_STDIN" || exit 3
command=$(sed -n 's/^\\! //p' "$STUB_STDIN")
bash -c "$command"
""",
    "temporal-sql-tool": r"""#!/bin/bash
echo "sql-tool $SPECMATE_TEMPORAL_SCHEMA $*" >> "$STUB_LOG"
if [[ "${STUB_FAIL_SCHEMA:-}" == "$SPECMATE_TEMPORAL_SCHEMA" && "$1" == update-schema ]]; then
  echo 'migration failed' >&2
  exit 1
fi
""",
    "temporal": r"""#!/bin/bash
echo "temporal $*" >> "$STUB_LOG"
case "$*" in
  *"namespace describe"*) [[ -e "$STUB_STATE/namespace" ]] ;;
  *"namespace create"*) touch "$STUB_STATE/namespace" ;;
esac
""",
    "temporal-server": r"""#!/bin/bash
echo "temporal-server $*" >> "$STUB_LOG"
for _ in $(seq 100); do
  [[ -e "$STUB_STATE/namespace" ]] && break
  sleep 0.05
done
""",
    "hostname": "#!/bin/bash\necho 10.0.0.9\n",
}


@pytest.fixture
def harness(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in STUBS.items():
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)
    state = tmp_path / "state"
    state.mkdir()
    migrate = tmp_path / "temporal-migrate.sh"
    shutil.copy(DEPLOY / "temporal-migrate.sh", migrate)
    entrypoint = tmp_path / "temporal-entrypoint.sh"
    entrypoint.write_text(
        (DEPLOY / "temporal-entrypoint.sh")
        .read_text()
        .replace("/opt/specmate/temporal-migrate.sh", str(migrate))
    )
    for script in (migrate, entrypoint):
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "log"
    env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "STUB_LOG": str(log),
        "STUB_STATE": str(state),
        "STUB_STDIN": str(tmp_path / "stdin.sql"),
        "POSTGRES_SEEDS": "db.invalid",
        "DBNAME": "temporal",
        "POSTGRES_USER": "temporal_user",
        "POSTGRES_PWD": "pw-main",
        "VISIBILITY_DBNAME": "temporal_visibility",
        "VISIBILITY_POSTGRES_USER": "visibility_user",
        "VISIBILITY_POSTGRES_PWD": "pw-visibility",
        "TEMPORAL_NAMESPACE": "specmate",
        "SPECMATE_STARTUP_TIMEOUT": "10",
    }

    class Harness:
        def __init__(self):
            self.entrypoint = entrypoint
            self.state = state

        def start(self, **extra):
            return subprocess.run(  # noqa: S603
                [str(entrypoint)],
                env={**env, **extra},
                capture_output=True,
                text=True,
                timeout=60,
            )

        def lines(self):
            return log.read_text().splitlines() if log.exists() else []

        def wait_for(self, prefix):
            for _ in range(100):
                if any(line.startswith(prefix) for line in self.lines()):
                    return True
                time.sleep(0.05)
            return False

        def reset_log(self):
            log.write_text("")

    return Harness()


def test_empty_start_migrates_both_schemas_then_creates_namespace_and_serves(harness):
    result = harness.start()
    assert result.returncode == 0, result.stderr
    assert harness.wait_for("temporal operator namespace create")
    lines = harness.lines()
    assert [line for line in lines if line.startswith("psql")] == [
        "psql db=temporal user=temporal_user",
        "psql db=temporal_visibility user=visibility_user",
    ]
    schemas = [line for line in lines if line.startswith("sql-tool")]
    assert [line.split()[1] for line in schemas] == ["temporal"] * 2 + ["visibility"] * 2
    assert "setup-schema" in schemas[0] and "update-schema" in schemas[1]
    assert "versioned" in schemas[1] and "/temporal/versioned" in schemas[1]
    assert "/visibility/versioned" in schemas[3]
    assert "temporal operator namespace create --namespace specmate --retention 72h" in lines
    assert "temporal-server --allow-no-auth start" in lines
    # Server start follows both migrations.
    assert lines.index("temporal-server --allow-no-auth start") > max(
        i for i, line in enumerate(lines) if line.startswith("sql-tool")
    )


def test_restart_reapplies_idempotently_and_keeps_the_existing_namespace(harness):
    assert harness.start().returncode == 0
    assert harness.wait_for("temporal operator namespace create")
    time.sleep(0.2)
    harness.reset_log()
    result = harness.start()
    assert result.returncode == 0, result.stderr
    assert harness.wait_for("temporal operator namespace describe")
    time.sleep(0.2)
    lines = harness.lines()
    assert sum(line.startswith("sql-tool") for line in lines) == 4
    assert not any("namespace create" in line for line in lines)
    assert "temporal-server --allow-no-auth start" in lines


@pytest.mark.parametrize("schema", ["temporal", "visibility"])
def test_migration_failure_exits_nonzero_and_never_reports_ready(harness, schema):
    result = harness.start(STUB_FAIL_SCHEMA=schema)
    assert result.returncode != 0
    assert "migration failed" in result.stderr
    time.sleep(0.3)
    lines = harness.lines()
    assert not any(line.startswith("temporal-server") for line in lines)
    assert not any(line.startswith("temporal operator") for line in lines)
    assert not (harness.state / "namespace").exists()
    if schema == "temporal":
        # The failing first schema stops before the visibility database is touched.
        assert not any("db=temporal_visibility" in line for line in lines)


def test_arguments_bypass_startup_entirely(harness):
    result = subprocess.run(  # noqa: S603
        [str(harness.entrypoint), "echo", "bypass"],
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == "bypass"
