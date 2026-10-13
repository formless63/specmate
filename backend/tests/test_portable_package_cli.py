"""Actual operation ZIPs accepted by a separate, isolated standard-library CLI."""

import base64
import json
import subprocess
import sys
from pathlib import Path

from .test_selected_firmware_packages import firmware_context  # noqa: F401
from .test_selected_packages import cable, package, request  # noqa: F401

VERIFIER = Path(__file__).resolve().parents[2] / "scripts/verify_selected_package.py"


def invoke(raw, digest, tmp_path):
    path = tmp_path / "selected.zip"
    path.write_bytes(raw)
    # Only a trusted checkout verifier is executed, never anything from the ZIP.
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-S", str(VERIFIER), str(path), "--manifest-sha256", digest],
        capture_output=True,
        check=False,
    )
    return result.returncode, json.loads(result.stdout)


def test_actual_cable_package_cli(users, cable, tmp_path):  # noqa: F811 - imported pytest fixture

    reviewed, downloaded, _ = package(users["viewer"], request(cable[0]))
    code, result = invoke(
        base64.b64decode(downloaded["archive_base64"]), reviewed["sha256"], tmp_path
    )
    assert code == 0
    assert result["integrity"] == "verified"
    assert result["manifest_identity"] == "independently_matched"
    assert result["authenticity"] == "not_verified"


def test_actual_firmware_package_cli_preserves_limits(
    users,
    firmware_context,  # noqa: F811 - imported pytest fixture
    tmp_path,
):

    payload = {**firmware_context["payload"], "rights_reviews": firmware_context["rights"]}
    reviewed, downloaded, _ = package(users["viewer"], payload)
    code, result = invoke(
        base64.b64decode(downloaded["archive_base64"]), reviewed["sha256"], tmp_path
    )
    assert code == 2
    assert result["integrity"] == "verified"
    assert result["completeness"] == "limited"
    assert result["physical_qualification"] == "not_evaluated"
