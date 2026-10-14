"""Registered compiler requests and leases enforce caller and frozen closure authority."""

import json

import pytest

from specmate.builds.models import BuildAttempt, BuildOutbox
from specmate.builds.operations import _execution_allowed
from specmate.firmware_builds.contracts import FirmwareRef
from specmate.firmware_builds.operations import inputs
from specmate.firmware_builds.pack import recipe_for
from specmate.operations import NotFound, PermissionDenied, ValidationFailed

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_firmware_builds import (  # noqa: F401
    IMAGE,
    attempt,
    board,
    compiler_recipe,
    fake_outputs,
    firmware,
    intake,
    payload,
    recipe,
    requested,
    source,
    sources,
)
from .test_transports import api


def test_registered_generic_build_cannot_bypass_source_execution_consent(
    users,
    project,
    firmware,  # noqa: F811
    compiler_recipe,  # noqa: F811
):
    before = BuildOutbox.objects.count()
    spec = json.loads(compiler_recipe["argv"][-1])
    with pytest.raises(PermissionDenied, match="explicit source-execution consent"):
        op(
            users["owner"],
            "build.request",
            {
                "workspace_id": workspace_of(project),
                "project_id": project,
                "source_revision_id": spec["sources"][0]["source_revision_id"],
                "recipe_id": compiler_recipe["id"],
            },
            idempotency_key="generic-compiler-bypass",
        )
    assert BuildOutbox.objects.count() == before
    assert not BuildAttempt.objects.filter(recipe_id=compiler_recipe["id"]).exists()
    mounted = api(users["viewer"]).get(
        f"/api/v0/firmware-builds/firmware/{firmware['revision_id']}"
    )
    assert mounted.status_code == 200
    assert mounted.json()["available_recipe_id"] == compiler_recipe["id"]


def test_shared_lease_rechecks_exact_frozen_occurrence_parent_authority(
    users,
    project,
    firmware,  # noqa: F811
    board,  # noqa: F811
    settings,
):
    owner = users["owner"]
    auxiliary = project
    draft = op(
        owner,
        "assembly.create",
        {
            "workspace_id": workspace_of(auxiliary),
            "name": "Exact contextual compiler target",
            "assembly": {
                "occurrences": [
                    {
                        "local_id": "board",
                        "revision_id": board[0]["revision_id"],
                        "assignments": {"firmware_revision_id": firmware["revision_id"]},
                    }
                ]
            },
        },
    )
    frozen = op(
        owner,
        "assembly.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    reference = FirmwareRef(
        firmware_revision_id=firmware["revision_id"],
        assembly_snapshot_id=frozen["snapshot_id"],
        path=["board"],
    )
    _, _, spec = inputs(owner, reference)
    approved = recipe_for(spec, IMAGE)
    settings.SPECMATE_APPROVED_RECIPES = {approved["id"]: approved}
    compiled_request = op(
        owner,
        "firmware_build.request",
        {
            **payload(firmware, approved),
            "assembly_snapshot_id": frozen["snapshot_id"],
            "path": ["board"],
        },
        idempotency_key="contextual-compiler-request",
    )
    build = BuildAttempt.objects.get(id=compiled_request["build_id"])
    assert _execution_allowed(build)
    assert op(owner, "build.get", {"build_id": compiled_request["build_id"]})["state"]
    # Losing the workspace revokes the requester's retained execution authority and reads.
    remove_member(owner, project=auxiliary)
    assert not _execution_allowed(build)
    with pytest.raises(NotFound):
        op(owner, "build.get", {"build_id": compiled_request["build_id"]})


@pytest.mark.parametrize("contradictory", [False, True])
def test_generic_artifact_release_uses_exact_compiler_handoff_acceptance(
    users,
    requested,  # noqa: F811
    contradictory,
):
    mutation = (lambda report, raws: report.update(tool_packages={})) if contradictory else None
    stage = fake_outputs(requested, mutation)
    output = stage.outputs.get(path="firmware.hex")
    client = api(users["viewer"])
    if contradictory:
        with pytest.raises(ValidationFailed):
            op(users["viewer"], "build.get", {"build_id": stage.build_id})
        with pytest.raises(ValidationFailed):
            op(
                users["viewer"],
                "build.output",
                {"build_id": stage.build_id, "output_id": output.id},
            )
        assert client.get(f"/api/v0/builds/{stage.build_id}/outputs/{output.id}").status_code == 422
    else:
        assert op(users["viewer"], "build.get", {"build_id": stage.build_id})["state"]
        response = client.get(f"/api/v0/builds/{stage.build_id}/outputs/{output.id}")
        assert response.status_code == 200
        assert b"".join(response.streaming_content) == b":0100000001FE\n:00000001FF\n"
