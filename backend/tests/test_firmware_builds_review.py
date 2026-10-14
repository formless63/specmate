"""Adversarial compiler contracts and authority, without native tool execution."""
# ruff: noqa: F811

import pytest

from specmate.firmware_builds import operations
from specmate.operations import NotFound

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_firmware_builds import (  # noqa: F401
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


def test_retained_build_denial_precedes_changed_occurrence_diagnostic(
    users, project, sources, firmware, compiler_recipe, requested, board
):
    from .test_firmware_builds import retained_derivative

    derivative = retained_derivative(users["owner"], sources["revision_id"])
    fake_outputs(requested, output_source=derivative.id)
    assembly = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Unassigned board context",
            "assembly": {
                "occurrences": [{"local_id": "board", "revision_id": board[0]["revision_id"]}]
            },
        },
    )
    frozen = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    remove_member(users["owner"], project=project)
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "firmware_build.request",
            {
                **payload(firmware, compiler_recipe),
                "assembly_snapshot_id": frozen["snapshot_id"],
                "path": ["board"],
            },
            idempotency_key="compile-one",
        )


def test_handoff_cannot_hide_contradictory_duplicate_claims(users, requested):
    import json

    from specmate.firmware_builds.pack import canonical
    from specmate.operations import ValidationFailed

    from .test_firmware_builds import digest, reference

    def contradictory(report, raws):
        handoff = json.loads(raws["handoff.json"])
        raws["handoff.json"] = b'{"flashing":"performed",' + canonical(handoff)[1:]
        # All transport and report hashes are consistent: acceptance must inspect
        # handoff meaning, not reject this fixture for an unrelated hash mismatch.
        for output in report["outputs"]:
            raw = raws[output["path"]]
            output.update(sha256=digest(raw), size=len(raw))

    fake_outputs(requested, contradictory)
    with pytest.raises(ValidationFailed):
        op(users["owner"], "firmware_build.read", reference(requested))


def test_compiler_rejects_unpinned_sibling_even_when_firmware_subset_is_valid(
    users, project, firmware, sources
):
    import json

    from specmate.builds.models import BuildAttempt
    from specmate.design.models import Revision
    from specmate.firmware_builds.contracts import FirmwareRef
    from specmate.operations import Unsupported

    from .test_firmware_builds import MAIN, digest
    from .test_sources import register

    register(users["owner"], project, b"preserved sibling")
    bundle = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Compiler input with an unselected sibling",
            "files": [
                {
                    "path": "main.c",
                    "sha256": digest(MAIN),
                    "rights": "MIT",
                    "media_type": "text/plain",
                },
                {
                    "path": "support.txt",
                    "sha256": digest(b"preserved sibling"),
                    "rights": "MIT",
                    "media_type": "text/plain",
                },
            ],
        },
    )
    spec = json.loads(bytes(Revision.objects.get(id=firmware["revision_id"]).snapshot.canonical))[
        "content"
    ]["firmware"]
    spec["sources"][0].update(
        source_revision_id=bundle["revision_id"], source_manifest_sha256=bundle["manifest_sha256"]
    )
    created = op(
        users["owner"],
        "firmware.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Deliberate subset declaration",
            "firmware": spec,
        },
    )
    frozen = op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    before = BuildAttempt.objects.count()
    with pytest.raises(Unsupported, match="entire exact bundle"):
        operations.executable_inputs(
            users["owner"], FirmwareRef(firmware_revision_id=frozen["revision_id"])
        )
    assert BuildAttempt.objects.count() == before


@pytest.mark.django_db(transaction=True)
def test_shared_and_compiler_downloads_recheck_reader_context_independently_of_requester(
    users, project, firmware, board, settings
):
    from specmate.builds.models import BuildAttempt
    from specmate.builds.operations import _execution_allowed
    from specmate.firmware_builds.contracts import FirmwareRef
    from specmate.firmware_builds.pack import recipe_for

    from .test_firmware_builds import IMAGE
    from .test_transports import api

    context_project = project
    assembly = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace_of(context_project),
            "name": "Independent contextual authority",
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
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    ref = FirmwareRef(
        firmware_revision_id=firmware["revision_id"],
        assembly_snapshot_id=frozen["snapshot_id"],
        path=["board"],
    )
    _, _, spec = operations.inputs(users["owner"], ref)
    approved = recipe_for(spec, IMAGE)
    settings.SPECMATE_APPROVED_RECIPES = {approved["id"]: approved}
    result = op(
        users["owner"],
        "firmware_build.request",
        {**payload(firmware, approved), **ref.model_dump(mode="json")},
        idempotency_key="reader-context",
    )
    stage = fake_outputs(result)
    output = stage.outputs.get(path="handoff.json")
    generic = f"/api/v0/builds/{stage.build_id}/outputs/{output.id}"
    specific = f"/api/v0/firmware-builds/firmware/{firmware['revision_id']}/builds/{stage.build_id}"
    query = f"?assembly_snapshot_id={frozen['snapshot_id']}&path=board"
    viewer = api(users["viewer"])
    response = viewer.get(generic)
    assert response.status_code == 200
    retained_bytes = b"".join(response.streaming_content)
    response.close()
    assert viewer.get(specific + query).status_code == 200
    # The reader loses the workspace; the requester still holds it, so execution of the
    # retained request stays allowed while the reader's context is checked independently.
    remove_member(users["viewer"], project=project)
    assert _execution_allowed(BuildAttempt.objects.get(id=stage.build_id))
    with pytest.raises(NotFound):
        op(users["viewer"], "build.get", {"build_id": stage.build_id})
    for route in (generic, specific + query, specific + f"/outputs/{output.id}" + query):
        denied = viewer.get(route)
        assert denied.status_code == 404
        assert b"source_execution" not in denied.content
        assert b"main.c" not in denied.content
    owner_response = api(users["owner"]).get(generic)
    assert owner_response.status_code == 200
    assert b"".join(owner_response.streaming_content) == retained_bytes
    owner_response.close()
