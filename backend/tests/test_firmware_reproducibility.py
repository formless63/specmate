"""BLD-006 for compiler builds and release manifests.

Registered compiler outputs are contract fixtures: no compiler, device or flashing is
involved. Comparisons are recorded through the same function the runner completion uses.
"""
# ruff: noqa: F811

import pytest

from specmate.builds.models import BuildAttempt, BuildStage, ReproducibilityComparison
from specmate.builds.reproducibility import record_comparisons
from specmate.operations import IdempotencyMismatch, PermissionDenied, ValidationFailed
from specmate.releases.models import Release

from .conftest import op
from .test_export_packages_outputs import approved_build, firmware_root
from .test_firmware_builds import (  # noqa: F401 -- pytest fixtures
    attempt,
    board,
    compiler_recipe,
    fake_outputs,
    firmware,
    intake,
    recipe,
    source,
    sources,
)

BASIS = "Reviewed exact occurrence; reproducibility check"


def token(build_id):
    return f"stage-v{BuildStage.objects.get(build_id=build_id).version}"


def reproduce(user, ref, build_id, key="fw-repro", **extra):
    return op(
        user,
        "firmware_build.reproduce",
        {
            **ref.model_dump(mode="json"),
            "build_id": build_id,
            "source_execution_authorized": True,
            "basis": BASIS,
            **extra,
        },
        expected_state=token(build_id),
        idempotency_key=key,
    )


def accept(build_id):
    """Register identical fixture outputs and record comparisons as completion would."""
    stage = fake_outputs({"build_id": build_id})
    return record_comparisons(stage)


def level(user, build_id):
    return op(user, "build.history", {"build_id": build_id})["reproducibility"]["level"]


def test_firmware_reproduce_uses_consent_path(users, project, firmware, board, settings):
    root = firmware_root(users, project, firmware, board)
    ref, first, _ = approved_build(users, firmware, root, settings, ["right"])
    build_id = first["build_id"]
    before = BuildAttempt.objects.count()
    assert level(users["viewer"], build_id) == "provenance"
    # The generic action cannot bypass the compiler consent hook.
    with pytest.raises(PermissionDenied):
        op(
            users["owner"],
            "build.reproduce",
            {"build_id": build_id},
            expected_state=token(build_id),
            idempotency_key="generic",
        )
    with pytest.raises(PermissionDenied):
        reproduce(users["viewer"], ref, build_id, key="viewer")
    with pytest.raises(ValidationFailed):
        reproduce(
            users["owner"], ref, build_id, key="no-consent", source_execution_authorized=False
        )
    assert BuildAttempt.objects.count() == before

    result = reproduce(users["owner"], ref, build_id)
    assert result["reproduction_of"] == build_id and result["source_execution_authorized"] is True
    assert result["reference"]["build_id"] == result["build_id"]
    assert reproduce(users["owner"], ref, build_id) == result
    with pytest.raises(IdempotencyMismatch):
        reproduce(users["owner"], ref, build_id, basis="different basis")
    again = BuildAttempt.objects.get(id=result["build_id"])
    assert again.input_key == BuildAttempt.objects.get(id=build_id).input_key

    assert accept(result["build_id"]) == 5
    assert level(users["viewer"], build_id) == "byte_reproducible"
    read = op(users["viewer"], "firmware_build.read", result["reference"])
    assert read["inputs"]["firmware_revision_id"] == firmware["revision_id"]


def test_release_cutoff_excludes_comparison_recorded_during_create(
    users, project, firmware, board, settings, monkeypatch
):
    root = firmware_root(users, project, firmware, board)
    ref, first, _ = approved_build(users, firmware, root, settings, ["right"])
    second = reproduce(users["owner"], ref, first["build_id"])
    build = {**ref.model_dump(mode="json"), "build_id": first["build_id"]}
    payload = {"root_revision_id": root["revision_id"], "quantity": 3, "firmware_builds": [build]}
    reviewed = op(users["viewer"], "release.review", payload)

    from specmate.releases import closure

    real = closure.build_package

    def build_then_compare(ctx, p, as_of=None, **kwargs):
        result = real(ctx, p, as_of=as_of, **kwargs)
        # A rerun is accepted after the manifest is built but before the release insert.
        if not ReproducibilityComparison.objects.exists():
            accept(second["build_id"])
        return result

    monkeypatch.setattr(closure, "build_package", build_then_compare)
    created = op(
        users["owner"],
        "release.create",
        {
            **payload,
            "name": "Synthetic firmware release",
            "reviewed_sha256": reviewed["sha256"],
            "acknowledgement": {"reason": "Synthetic evaluation; rights open."},
        },
    )
    monkeypatch.undo()
    row = Release.objects.get(id=created["release_id"])
    comparison = ReproducibilityComparison.objects.get(path="firmware.elf")
    assert row.reproducibility_as_of < comparison.created_at
    verified = op(users["viewer"], "release.verify", {"release_id": created["release_id"]})
    assert verified["reconstruction"] == "identical" and verified["problems"] == []
    # The new evidence is visible to fresh reads, never to the retained release.
    assert level(users["viewer"], first["build_id"]) == "byte_reproducible"
    fresh = op(users["viewer"], "export_package.review", payload)["manifest"]
    output = next(o for o in fresh["outputs"] if o["kind"] == "firmware_build")
    assert output["reproducibility"]["level"] == "byte_reproducible"


def test_firmware_retry_uses_consent_path(users, project, firmware, board, settings):
    """The generic retry is refused by the compiler consent hook; the firmware one works."""
    from specmate.firmware_builds.contracts import FirmwareRef
    from specmate.firmware_builds.pack import recipe_for

    from .test_firmware_builds import IMAGE

    root = firmware_root(users, project, firmware, board)
    ref = FirmwareRef(
        firmware_revision_id=firmware["revision_id"],
        assembly_snapshot_id=root["snapshot_id"],
        path=["right"],
    )
    from specmate.firmware_builds import operations as firmware_operations

    _, _, spec = firmware_operations.inputs(users["owner"], ref)
    item = recipe_for(spec, IMAGE)
    settings.SPECMATE_APPROVED_RECIPES = {item["id"]: item}
    failed = op(
        users["owner"],
        "firmware_build.request",
        {
            **ref.model_dump(mode="json"),
            "recipe_id": item["id"],
            "source_execution_authorized": True,
            "basis": BASIS,
        },
        idempotency_key="compile",
    )["build_id"]
    stage = BuildStage.objects.get(build_id=failed)
    stage.cancellation_requested_at = None
    stage.state, stage.receipt = "failed", {"outcome": "failed", "exit_code": 1, "outputs": []}
    stage.save()
    before = BuildAttempt.objects.count()
    with pytest.raises(PermissionDenied):
        op(
            users["owner"],
            "build.retry",
            {"build_id": failed},
            expected_state=token(failed),
            idempotency_key="generic",
        )
    with pytest.raises(PermissionDenied):
        retry(users["viewer"], ref, failed, key="viewer")
    with pytest.raises(ValidationFailed):
        retry(users["owner"], ref, failed, key="no-consent", source_execution_authorized=False)
    assert BuildAttempt.objects.count() == before
    result = retry(users["owner"], ref, failed)
    assert result["retry_of"] == failed and result["reference"]["build_id"] == result["build_id"]
    assert retry(users["owner"], ref, failed) == result
    attempt = BuildAttempt.objects.get(id=result["build_id"])
    assert attempt.retry_of_id == stage.build_id
    assert attempt.input_key == stage.build.input_key
    # A reproducibility check is refused for a build that was never accepted.
    from specmate.operations import Conflict

    with pytest.raises(Conflict):
        reproduce(users["owner"], ref, failed, key="not-accepted")


def retry(user, ref, build_id, key="fw-retry", **extra):
    return op(
        user,
        "firmware_build.retry",
        {
            **ref.model_dump(mode="json"),
            "build_id": build_id,
            "source_execution_authorized": True,
            "basis": BASIS,
            **extra,
        },
        expected_state=token(build_id),
        idempotency_key=key,
    )


def test_identical_compile_request_is_offered_reuse_without_execution_consent(
    users, project, firmware, board, settings
):
    root = firmware_root(users, project, firmware, board)
    _, first, _ = approved_build(users, firmware, root, settings, ["right"])
    build = BuildAttempt.objects.get(id=first["build_id"])
    lookup = {
        "workspace_id": str(build.workspace_id),
        "source_revision_id": str(build.source_revision_id),
        "recipe_id": build.recipe_id,
    }
    before = BuildAttempt.objects.count()
    offer = op(users["owner"], "build.find_reusable", lookup)["reusable"]
    # Matching uses the reproducibility input key; one acceptance is provenance only.
    assert offer["build_id"] == first["build_id"]
    assert offer["reproducibility"] == "provenance"
    reused = op(users["owner"], "build.reuse", {**lookup, "result_build_id": first["build_id"]})
    assert reused["build_id"] == first["build_id"] and reused["reuse_id"]
    assert BuildAttempt.objects.count() == before
    # Reuse needs build.execute; a viewer is refused before any lookup result is disclosed.
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "build.find_reusable", lookup)
