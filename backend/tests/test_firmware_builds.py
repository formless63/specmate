"""FW003 operation/acceptance contracts. Registered test receipts are not native proof."""

import copy
import io
import json
from uuid import uuid4

import pytest
from django.test import RequestFactory

from specmate.access.models import WorkspaceMember
from specmate.builds.models import BuildAttempt, BuildOutbox, BuildStage, StageOutput
from specmate.builds.recipes import Recipe
from specmate.firmware_builds import operations
from specmate.firmware_builds.api import download_output, read_options
from specmate.firmware_builds.contracts import FirmwareRef
from specmate.firmware_builds.pack import (
    OUTPUT_MEDIA,
    TOOL_PACKAGES,
    TOOLCHAIN,
    canonical,
    recipe_for,
)
from specmate.operations import (
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unsupported,
    ValidationFailed,
)
from specmate.sources import blobstore

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_firmware import (  # noqa: F401
    attempt,
    board,
    declaration,
    digest,
    intake,
    recipe,
    source,
)
from .test_sources import register

MAIN = (
    b"#include <stdint.h>\nvolatile uint8_t counter;\n"
    b"int main(void) { counter = COUNT; for (;;) { counter++; } }\n"
)
IMAGE = "synthetic-contract-compiler@sha256:" + "1" * 64


@pytest.fixture
def sources(users, project):
    register(users["owner"], project, MAIN)
    return op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Original synthetic compile input",
            "files": [
                {
                    "path": "main.c",
                    "sha256": digest(MAIN),
                    "media_type": "text/plain",
                    "rights": "MIT",
                }
            ],
        },
    )


@pytest.fixture
def firmware(users, project, sources, board):  # noqa: F811
    content = declaration(sources, board)
    content["sources"][0]["files"] = [
        {"path": "main.c", "sha256": digest(MAIN), "rights": "MIT", "role": "application"}
    ]
    content["toolchain"] = TOOLCHAIN
    content["configuration"] = [{"key": "COUNT", "status": "known", "value": "7"}]
    created = op(
        users["owner"],
        "firmware.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic baremetal compiler declaration",
            "firmware": content,
        },
    )
    return op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )


@pytest.fixture
def compiler_recipe(users, firmware, settings):
    _, _, spec = operations.inputs(
        users["owner"], FirmwareRef(firmware_revision_id=firmware["revision_id"])
    )
    item = recipe_for(spec, IMAGE)
    settings.SPECMATE_APPROVED_RECIPES = {item["id"]: item}
    return item


def payload(firmware, compiler_recipe):
    return {
        "firmware_revision_id": firmware["revision_id"],
        "recipe_id": compiler_recipe["id"],
        "source_execution_authorized": True,
        "basis": "Reviewed original synthetic source compilation",
    }


@pytest.fixture
def requested(users, firmware, compiler_recipe):
    return op(
        users["owner"],
        "firmware_build.request",
        payload(firmware, compiler_recipe),
        idempotency_key="compile-one",
    )


def fake_outputs(requested, mutation=None, output_source=None):
    """Structural acceptance fixture, never presented as compiler qualification."""
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    spec = json.loads(stage.build.recipe["argv"][-1])
    elf = bytearray(52)
    elf[:7] = b"\x7fELF\x01\x01\x01"
    elf[18:20] = (83).to_bytes(2, "little")
    raws = {
        "firmware.elf": bytes(elf),
        "firmware.hex": b":0100000001FE\n:00000001FF\n",
        "compile.log": b"contract-only fixture; no compiler invoked\n",
    }
    raws["handoff.json"] = canonical(
        {
            "format_version": 1,
            "inputs": spec,
            "hardware_compatibility": "not_evaluated",
            "flashing": "not_performed",
            "device_operation": "not_observed",
            "physical_qualification": False,
        }
    )
    report = {
        "format_version": 1,
        "adapter": "firmware-avr-gcc-v1",
        "input_sha256": digest(canonical(spec)),
        "compiler_version": "5.4.0",
        "tool_packages": TOOL_PACKAGES,
        "compiler_exit_code": 0,
        "source_unchanged": True,
        "outputs": [
            {"path": p, "sha256": digest(raw), "size": len(raw)} for p, raw in raws.items()
        ],
        "hardware_compatibility": "not_evaluated",
        "flashing": "not_performed",
        "device_operation": "not_observed",
        "physical_qualification": False,
    }
    if mutation:
        mutation(report, raws)
    raws["compile.json"] = canonical(report)
    for path, raw in raws.items():
        blobstore.promote(blobstore.stage(io.BytesIO(raw), 16 * 1024**2))
        StageOutput.objects.create(
            stage=stage,
            path=path,
            sha256=digest(raw),
            size=len(raw),
            media_type=OUTPUT_MEDIA[path],
            rights="MIT",
            source_revision_id=output_source or stage.build.source_revision_id,
        )
    stage.state = "succeeded"
    stage.receipt = {
        "outcome": "succeeded",
        "exit_code": 0,
        "outputs": [{"path": o.path, "sha256": o.sha256} for o in stage.outputs.all()],
    }
    stage.save()
    return stage


def reference(requested):
    return requested["reference"]


def test_request_consent_idempotency_approved_profile_and_outbox(
    users, firmware, compiler_recipe, requested, settings
):
    p = payload(firmware, compiler_recipe)
    assert (
        op(users["owner"], "firmware_build.request", p, idempotency_key="compile-one") == requested
    )
    assert BuildOutbox.objects.filter(build_id=requested["build_id"]).count() == 1
    assert BuildAttempt.objects.filter(recipe_id=compiler_recipe["id"]).count() == 1
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "firmware_build.request",
            {**p, "basis": "different review"},
            idempotency_key="compile-one",
        )
    for name, error in [("viewer", PermissionDenied), ("outsider", NotFound)]:
        with pytest.raises(error):
            op(users[name], "firmware_build.request", p, idempotency_key="denied")
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "firmware_build.request",
            {**p, "source_execution_authorized": False},
            idempotency_key="no-consent",
        )
    altered = copy.deepcopy(compiler_recipe)
    altered["argv"][2] += '\nprint("altered")'
    settings.SPECMATE_APPROVED_RECIPES = {altered["id"]: altered}
    with pytest.raises(Unsupported):
        op(users["owner"], "firmware_build.request", p, idempotency_key="compile-one")


def test_generic_request_hook_rejects_consent_bypass(users, firmware, compiler_recipe):
    from specmate.builds.operations import RequestBuild
    from specmate.operations import Context

    source_id = json.loads(compiler_recipe["argv"][-1])["sources"][0]["source_revision_id"]
    with pytest.raises(PermissionDenied):
        operations.authorize_request(
            Context(user=users["owner"], via="job", request_id="hook"),
            RequestBuild(
                workspace_id=operations.inputs(
                    users["owner"], FirmwareRef(firmware_revision_id=firmware["revision_id"])
                )[0].definition.workspace_id,
                source_revision_id=source_id,
                recipe_id=compiler_recipe["id"],
            ),
            Recipe.model_validate(compiler_recipe),
        )


def test_handoff_exact_provenance_download_and_current_authority(users, firmware, requested):
    stage = fake_outputs(requested)
    item = op(users["viewer"], "firmware_build.read", reference(requested))
    assert item["report"]["flashing"] == "not_performed"
    assert item["report"]["device_operation"] == "not_observed"
    assert item["inputs"]["firmware_revision_id"] == firmware["revision_id"]
    request = RequestFactory().get("/")
    request.user = users["viewer"]
    output = stage.outputs.get(path="handoff.json")
    response = download_output(request, firmware["revision_id"], stage.build_id, output.id)
    assert digest(b"".join(response.streaming_content)) == output.sha256
    listed = read_options(request, firmware["revision_id"])["builds"][0]
    assert listed["state"] == "succeeded" and listed["retry_of"] is None
    assert item["retry_of"] is None
    assert item["lineage"] == [
        {"build_id": str(stage.build_id), "state": "succeeded", "current": True}
    ]
    WorkspaceMember.objects.filter(user=users["viewer"]).delete()
    with pytest.raises(NotFound):
        op(users["viewer"], "firmware_build.read", reference(requested))
    with pytest.raises(NotFound):
        download_output(request, firmware["revision_id"], stage.build_id, output.id)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r, raw: r.update(input_sha256="a" * 64),
        lambda r, raw: r.update(flashing="performed"),
        lambda r, raw: r.update(tool_packages={}),
        lambda r, raw: r["outputs"][0].update(sha256="b" * 64),
        lambda r, raw: raw.update(**{"firmware.hex": b":0100000001FF\n:00000001FF\n"}),
    ],
)
def test_contradictory_outputs_never_become_handoff(users, requested, mutation):
    fake_outputs(requested, mutation)
    with pytest.raises(ValidationFailed):
        op(users["owner"], "firmware_build.read", reference(requested))


def test_failed_stage_and_mismatched_firmware_are_not_handoffs(users, requested):
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    stage.state = "failed"
    stage.receipt = {"outcome": "failed", "exit_code": 1, "message": "original syntax error"}
    stage.save()
    with pytest.raises(ValidationFailed):
        op(users["owner"], "firmware_build.read", reference(requested))
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "firmware_build.read",
            {**reference(requested), "firmware_revision_id": str(uuid4())},
        )


def test_source_revocation_precedes_key_mismatch(users, firmware, compiler_recipe, requested):
    WorkspaceMember.objects.filter(user=users["owner"]).delete()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "firmware_build.request",
            {**payload(firmware, compiler_recipe), "recipe_id": "changed"},
            idempotency_key="compile-one",
        )


def test_exact_frozen_occurrence_binding(users, firmware, compiler_recipe, board, settings):  # noqa: F811
    draft = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": str(
                operations.inputs(
                    users["owner"], FirmwareRef(firmware_revision_id=firmware["revision_id"])
                )[0].definition.workspace_id
            ),
            "name": "Synthetic repeated compiler targets",
            "assembly": {
                "occurrences": [
                    {
                        "local_id": local,
                        "revision_id": board[0]["revision_id"],
                        "assignments": {"firmware_revision_id": firmware["revision_id"]},
                    }
                    for local in ("left", "right")
                ]
            },
        },
    )
    frozen = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    ref = FirmwareRef(
        firmware_revision_id=firmware["revision_id"],
        assembly_snapshot_id=frozen["snapshot_id"],
        path=["right"],
    )
    _, _, spec = operations.inputs(users["owner"], ref)
    item = recipe_for(spec, IMAGE)
    settings.SPECMATE_APPROVED_RECIPES = {item["id"]: item}
    result = op(
        users["owner"],
        "firmware_build.request",
        {
            **ref.model_dump(mode="json"),
            "recipe_id": item["id"],
            "source_execution_authorized": True,
            "basis": "Reviewed exact right occurrence",
        },
        idempotency_key="right-compile",
    )
    fake_outputs(result)
    read = op(users["viewer"], "firmware_build.read", reference(result))
    assert read["inputs"]["occurrence"]["path"] == ["right"]
    with pytest.raises(Unsupported):
        op(users["viewer"], "firmware_build.read", {**reference(result), "path": ["left"]})
    assert spec["firmware_revision_id"] == firmware["revision_id"]


def retained_derivative(user, source_revision_id):
    """Synthetic retained derivative in the source's own workspace; no bytes fabricated."""
    from specmate.sources.models import SourceBundle, SourceBundleFile, SourceBundleRevision

    origin = SourceBundleRevision.objects.select_related("bundle").get(id=source_revision_id)
    bundle = SourceBundle.objects.create(
        workspace_id=origin.bundle.workspace_id,
        name="Synthetic retained derivative",
        role="derivative",
        derived_from_id=origin.id,
        created_by=user,
    )
    revision = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=origin.manifest,
        manifest_sha256=origin.manifest_sha256,
        created_by=user,
    )
    for file in origin.files.all():
        SourceBundleFile.objects.create(
            revision=revision,
            path=file.path,
            blob=file.blob,
            rights=file.rights,
            media_type=file.media_type,
        )
    return revision


def test_hidden_output_ancestor_precedes_hash_diagnostic_and_replay(
    users, project, sources, firmware, compiler_recipe, requested
):
    derivative = retained_derivative(users["owner"], sources["revision_id"])
    fake_outputs(requested, output_source=derivative.id)
    # The derivative's hash diagnostic is reachable only while the workspace is.
    with pytest.raises(ValidationFailed):
        op(users["owner"], "firmware_build.read", reference(requested))
    # Losing workspace membership hides the whole retained ancestry before any diagnostic.
    remove_member(users["owner"], project=project)
    with pytest.raises(NotFound):
        op(users["owner"], "firmware_build.read", reference(requested))
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "firmware_build.request",
            {**payload(firmware, compiler_recipe), "recipe_id": "different"},
            idempotency_key="compile-one",
        )


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value["toolchain"].update(family="platformio"),
        lambda value: value["toolchain"].update(version=None),
        lambda value: value["configuration"][0].update(status="unknown", value=None),
        lambda value: value["configuration"][0].update(status="secret_reference", value=None),
        lambda value: value["sources"][0]["files"][0].update(path="main.cpp"),
        lambda value: value["sources"][0]["files"].append(
            {"path": "build.py", "sha256": "3" * 64, "rights": "MIT", "role": "configuration"}
        ),
    ],
)
def test_unknown_or_unsupported_inputs_fail_explicitly(users, firmware, change):
    _, _, spec = operations.inputs(
        users["owner"], FirmwareRef(firmware_revision_id=firmware["revision_id"])
    )
    change(spec)
    with pytest.raises(Unsupported):
        recipe_for(spec, IMAGE)


@pytest.mark.parametrize(
    "snapshot,path", [(None, "right"), (str(uuid4()), ""), (str(uuid4()), "../board")]
)
def test_malformed_api_occurrence_is_typed_validation_failure(users, firmware, snapshot, path):
    request = RequestFactory().get("/")
    request.user = users["owner"]
    with pytest.raises(ValidationFailed):
        read_options(request, firmware["revision_id"], snapshot, path)
