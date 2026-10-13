"""Adversarial compiler contracts and authority, without native tool execution."""
# ruff: noqa: F811

import pytest

from specmate.access.models import Membership
from specmate.firmware_builds import operations
from specmate.operations import NotFound

from .conftest import op
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
    from .test_pcb_fabrication import derived_record, other_source

    parent_project, parent = other_source(users)
    derivative = derived_record(users["owner"], sources["revision_id"], parent)
    fake_outputs(requested, output_source=derivative.id)
    assembly = op(
        users["owner"],
        "assembly.create",
        {
            "project_id": project,
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
    Membership.objects.filter(user=users["owner"], project_id=parent_project).delete()
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
            "project_id": project,
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
        {"project_id": project, "name": "Deliberate subset declaration", "firmware": spec},
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
