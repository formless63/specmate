"""OPS-001: the installation environment is generated once, privately and without
external service credentials."""

import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
CONFIGURE = REPO / "deploy" / "configure.py"
SECRETS = (
    "SPECMATE_SECRET_KEY",
    "POSTGRES_PASSWORD",
    "SPECMATE_DB_PASSWORD",
    "TEMPORAL_DB_PASSWORD",
    "TEMPORAL_VISIBILITY_DB_PASSWORD",
)


def run_configure(output):
    return subprocess.run(  # noqa: S603
        [sys.executable, "-I", str(CONFIGURE), "--output", str(output)],
        capture_output=True,
        text=True,
    )


def parse_env(path):
    values = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key] = value
    return values


@pytest.fixture
def created(tmp_path):
    output = tmp_path / "install" / ".env"
    output.parent.mkdir()
    result = run_configure(output)
    assert result.returncode == 0, result.stderr
    return output


def test_every_secret_is_generated_distinct_and_strong(created):
    env = parse_env(created)
    generated = [env[name] for name in SECRETS]
    assert all(len(value) >= 48 and re.fullmatch(r"[A-Za-z0-9_-]+", value) for value in generated)
    assert len(set(generated)) == len(SECRETS)


def test_paths_are_filled_and_nothing_else_is_left_unfilled_by_mistake(created):
    env = parse_env(created)
    assert env["SPECMATE_SOURCE_DIR"] == str(REPO)
    assert env["SPECMATE_RUNNER_HOST_STATE_DIR"] == str(created.resolve().parent / "runner-state")
    example = parse_env(REPO / ".env.example")
    assert set(example) <= set(env)


def test_no_mail_identity_erp_or_ai_credentials_are_required(created):
    env = parse_env(created)
    for needle in ("SMTP", "MAIL", "OIDC", "OAUTH", "SAML", "LDAP", "ERP", "OPENAI", "ANTHROPIC"):
        assert not [key for key in env if needle in key], needle
    # Only the generated secrets are credentials; no other key has to be supplied.
    blank_required = [name for name in SECRETS if not env[name]]
    assert blank_required == []


def test_file_modes(created):
    assert stat.S_IMODE(created.stat().st_mode) == 0o600
    for name in ("recipes.json", "tools-enabled.json"):
        assert stat.S_IMODE((created.parent / name).stat().st_mode) == 0o644
    assert (created.parent / "recipes.json").read_text() == "{}\n"
    assert '"enabled": {}' in (created.parent / "tools-enabled.json").read_text()


def test_rerun_refuses_and_keeps_existing_credentials_and_operator_files(created):
    before = created.read_bytes()
    (created.parent / "recipes.json").write_text('{"kept": true}\n')
    (created.parent / "tools-enabled.json").write_text("operator decision\n")
    result = run_configure(created)
    assert result.returncode != 0
    assert "FileExistsError" in result.stderr
    assert created.read_bytes() == before
    assert (created.parent / "recipes.json").read_text() == '{"kept": true}\n'
    assert (created.parent / "tools-enabled.json").read_text() == "operator decision\n"


def test_separate_installations_do_not_share_secrets(tmp_path):
    envs = []
    for name in ("a", "b"):
        output = tmp_path / name / ".env"
        output.parent.mkdir()
        assert run_configure(output).returncode == 0
        envs.append(parse_env(output))
    assert all(envs[0][name] != envs[1][name] for name in SECRETS)
