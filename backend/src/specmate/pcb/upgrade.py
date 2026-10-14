"""Recorded KiCad 10 format upgrade of an older board as a derivative source bundle.

The original revision is never modified. A deliberate, approved native stage runs the
pinned ``kicad-cli pcb upgrade`` (and ``sch upgrade`` for the bundle's schematics) on
private copies. Accepting the successful stage creates a derivative bundle whose
ancestry is the original revision, carrying the upgraded bytes in place of the old
ones and every other file unchanged, plus a new intake for extraction to run on.
"""

import hashlib
import json
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError as PydanticValidationError

from specmate.access.permissions import Perm, authorize
from specmate.builds.models import BuildStage
from specmate.builds.operations import RequestBuild, request_build
from specmate.builds.recipes import Recipe, approved_recipe
from specmate.design.operations import canonical_bytes
from specmate.operations import Context, NotFound, Unsupported, ValidationFailed, operation
from specmate.pcb.formats import UPGRADABLE_BOARD_FORMATS
from specmate.pcb.models import PcbFormatUpgrade, PcbIntake, PcbUpgradeAttempt
from specmate.pcb.pack import (
    MAX_REPORT_BYTES,
    MAX_UPGRADE_OUTPUT_BYTES,
    MAX_UPGRADE_SCHEMATICS,
    UPGRADE_REPORT_PATH,
    upgrade_inputs,
    upgrade_recipe_for,
)
from specmate.pcb.upgrade_report import UpgradeReport
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob, SourceBundle
from specmate.sources.operations import FileRef, _write_revision

UPGRADABLE_MAJORS = sorted(set(UPGRADABLE_BOARD_FORMATS.values()))


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RequestUpgrade(Payload):
    intake_id: UUID
    recipe_id: str = Field(min_length=1, max_length=128)


class UpgradeRef(Payload):
    upgrade_attempt_id: UUID


def _intake(ctx, intake_id, perm):
    from specmate.pcb.operations import intake_for

    return intake_for(ctx, intake_id, perm)


def expected_recipe(intake):
    """The exact upgrade recipe for this intake's board and the bundle's schematics."""
    if not intake.board_path:
        raise Unsupported("This intake has no board selected to upgrade.")
    if hasattr(intake.source_revision, "pcb_format_upgrade"):
        raise Unsupported("This board is already a recorded KiCad 10 format upgrade.")
    board = intake.source_revision.files.filter(path=intake.board_path).first()
    if board is None:
        raise Unsupported("This intake has no supported native board selected.")
    schematics = upgrade_inputs(intake.source_revision.files.values_list("path", flat=True))
    if len(schematics) > MAX_UPGRADE_SCHEMATICS:
        raise Unsupported(
            f"One upgrade stage converts at most {MAX_UPGRADE_SCHEMATICS} schematics; "
            f"this bundle has {len(schematics)}."
        )
    return (
        board,
        schematics,
        Recipe.model_validate(upgrade_recipe_for(intake.board_path, board.rights, schematics)),
    )


def validate_upgrade_recipe(intake, recipe):
    board, schematics, expected = expected_recipe(intake)
    if recipe.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise Unsupported("Approved recipe does not match the pinned KiCad format upgrade adapter.")
    return board, schematics


def available_upgrade_recipe(intake):
    try:
        _, _, expected = expected_recipe(intake)
        approved = approved_recipe(expected.id)
        validate_upgrade_recipe(intake, approved)
        return approved.id
    except (Unsupported, ValidationFailed):
        return None


def _scope(ctx, payload):
    from specmate.operations.scope import workspace_scope

    if isinstance(payload, RequestUpgrade):
        intake = _intake(ctx, payload.intake_id, Perm.BUILD_EXECUTE)
    else:
        attempt = PcbUpgradeAttempt.objects.filter(id=payload.upgrade_attempt_id).first()
        if attempt is None:
            raise NotFound("PCB upgrade attempt not found.")
        intake = _intake(ctx, attempt.intake_id, Perm.SOURCE_REGISTER)
    return workspace_scope(ctx, intake.source_revision.bundle.workspace_id)


def _replay(ctx, payload, stored):
    if isinstance(payload, RequestUpgrade):
        intake = _intake(ctx, payload.intake_id, Perm.BUILD_EXECUTE)
        validate_upgrade_recipe(intake, approved_recipe(payload.recipe_id))
        attempt = (
            PcbUpgradeAttempt.objects.select_related("build")
            .filter(id=stored["upgrade_attempt_id"], intake=intake, build_id=stored["build_id"])
            .first()
        )
        if attempt is None or attempt.build.source_revision_id != intake.source_revision_id:
            raise ValidationFailed("Saved PCB upgrade provenance is invalid.")
        validate_upgrade_recipe(intake, Recipe.model_validate(attempt.build.recipe))
        return
    attempt = _attempt(ctx, payload.upgrade_attempt_id)
    upgrade = (
        PcbFormatUpgrade.objects.select_related("intake__source_revision__bundle")
        .filter(attempt=attempt, id=stored["format_upgrade"]["upgrade_id"])
        .first()
    )
    if upgrade is None or str(upgrade.intake_id) != stored["intake_id"]:
        raise ValidationFailed("Saved PCB upgrade provenance is invalid.")
    authorize(ctx.user, upgrade.intake.source_revision.bundle.workspace_id, Perm.SOURCE_REGISTER)


def _attempt(ctx, attempt_id):
    attempt = (
        PcbUpgradeAttempt.objects.select_related("intake__source_revision__bundle", "build")
        .filter(id=attempt_id)
        .first()
    )
    if attempt is None:
        raise NotFound("PCB upgrade attempt not found.")
    _intake(ctx, attempt.intake_id, Perm.SOURCE_REGISTER)
    return attempt


@operation(
    "pcb.request_upgrade",
    RequestUpgrade,
    idempotency_scope=_scope,
    authorize_replay=_replay,
    status="accepted_async",
    summary=(
        "Request the recorded KiCad 10 format upgrade of an older board; the original "
        "is never modified."
    ),
    access=Perm.BUILD_EXECUTE,
)
def request_upgrade(ctx: Context, p: RequestUpgrade):
    intake = _intake(ctx, p.intake_id, Perm.BUILD_EXECUTE)
    validate_upgrade_recipe(intake, approved_recipe(p.recipe_id))
    build = request_build(
        ctx,
        RequestBuild(
            workspace_id=intake.source_revision.bundle.workspace_id,
            source_revision_id=intake.source_revision_id,
            recipe_id=p.recipe_id,
        ),
    )
    attempt = PcbUpgradeAttempt.objects.create(intake=intake, build_id=build["build_id"])
    return {"intake_id": str(intake.id), "upgrade_attempt_id": str(attempt.id), **build}


def _verified_bytes(sha256, size, limit, keep=True):
    digest, total, chunks = hashlib.sha256(), 0, []
    try:
        with blobstore.open_blob(sha256) as stream:
            while total <= limit and (chunk := stream.read(1024**2)):
                digest.update(chunk)
                total += len(chunk)
                if keep:
                    chunks.append(chunk)
    except OSError:
        raise ValidationFailed("Upgraded output bytes are unavailable.") from None
    if total != size or total > limit or digest.hexdigest() != sha256:
        raise ValidationFailed("Stored upgrade output no longer matches its verified receipt.")
    return b"".join(chunks)


@operation(
    "pcb.accept_upgrade",
    UpgradeRef,
    idempotency_scope=_scope,
    authorize_replay=_replay,
    summary=(
        "Register a successful native format upgrade as a derivative source bundle with "
        "the original as ancestry, and open an intake on it."
    ),
    access=Perm.SOURCE_REGISTER,
)
def accept_upgrade(ctx: Context, p: UpgradeRef):
    attempt = _attempt(ctx, p.upgrade_attempt_id)
    intake = attempt.intake
    original = intake.source_revision
    board, schematics = validate_upgrade_recipe(intake, Recipe.model_validate(attempt.build.recipe))
    if (
        attempt.build.source_revision_id != original.id
        or attempt.build.workspace_id != original.bundle.workspace_id
    ):
        raise ValidationFailed("Build provenance does not match intake.")
    stage = BuildStage.objects.select_for_update().get(build=attempt.build)
    existing = PcbFormatUpgrade.objects.filter(attempt=attempt).first()
    if existing is not None:
        return accepted_result(existing)
    if stage.state != "succeeded":
        raise ValidationFailed("Native upgrade has no accepted successful receipt.")
    outputs = {o.path: o for o in stage.outputs.all()}
    declared = {o["path"] for o in attempt.build.recipe["outputs"]}
    if (
        set(outputs) != declared
        or any(
            o.source_revision_id != original.id or o.rights != board.rights
            for o in outputs.values()
        )
        or stage.receipt.get("outcome") != "succeeded"
        or stage.receipt.get("exit_code") != 0
        or sorted(stage.receipt.get("outputs", []), key=lambda o: o["path"])
        != sorted(
            ({"path": o.path, "sha256": o.sha256} for o in outputs.values()),
            key=lambda o: o["path"],
        )
    ):
        raise ValidationFailed("Native upgrade receipt does not match its declared outputs.")
    report_output = outputs[UPGRADE_REPORT_PATH]
    if report_output.media_type != "application/json" or report_output.size > MAX_REPORT_BYTES:
        raise ValidationFailed("Native upgrade report provenance is invalid.")
    content = _verified_bytes(report_output.sha256, report_output.size, MAX_REPORT_BYTES)
    try:
        report = UpgradeReport.model_validate_json(content)
    except PydanticValidationError:
        raise ValidationFailed("Native upgrade report is invalid or unsupported.") from None
    if [f.path for f in report.files] != [intake.board_path, *schematics]:
        raise ValidationFailed("Upgrade report does not cover exactly the requested files.")
    originals = {f.path: f for f in original.files.select_related("blob")}
    for entry in report.files:
        output = outputs[entry.output_path]
        if originals[entry.path].blob.sha256 != entry.source_sha256:
            raise ValidationFailed("Upgrade report refers to different original bytes.")
        if output.sha256 != entry.output_sha256:
            raise ValidationFailed("Upgrade report disagrees with the verified output bytes.")
        _verified_bytes(output.sha256, output.size, MAX_UPGRADE_OUTPUT_BYTES, keep=False)
    workspace_id = original.bundle.workspace_id
    replaced = {}
    for entry in report.files:
        output = outputs[entry.output_path]
        SourceBlob.objects.get_or_create(
            workspace_id=workspace_id,
            sha256=output.sha256,
            defaults={
                "size": output.size,
                "media_type": originals[entry.path].media_type,
                "registered_by": ctx.user,
            },
        )
        replaced[entry.path] = output.sha256
    bundle = SourceBundle.objects.create(
        workspace_id=workspace_id,
        name=f"{original.bundle.name} (KiCad 10 format upgrade)"[:200],
        role=SourceBundle.Role.DERIVATIVE,
        derived_from=original,
        created_by=ctx.user,
    )
    files = [
        FileRef(
            path=f.path,
            sha256=replaced.get(f.path, f.blob.sha256),
            media_type=f.media_type,
            rights=f.rights,
        )
        for f in originals.values()
    ]
    revision = _write_revision(ctx, bundle, files, ancestry=[str(original.id)])
    derived = PcbIntake.objects.create(
        source_revision=revision, board_path=intake.board_path, created_by=ctx.user
    )
    canonical = canonical_bytes(report.model_dump(mode="json"))
    upgrade = PcbFormatUpgrade.objects.create(
        attempt=attempt,
        revision=revision,
        intake=derived,
        report_output=report_output,
        canonical=canonical,
        sha256=hashlib.sha256(canonical).hexdigest(),
        from_kicad_major=report.board.from_kicad_major,
        from_format_version=report.board.from_format_version,
        to_format_version=report.board.to_format_version,
        tool_version=report.tool_version,
        image=attempt.build.recipe["image"],
        accepted_by=ctx.user,
    )
    return accepted_result(upgrade)


def accepted_result(upgrade):
    from specmate.pcb.operations import intake_result

    return {**intake_result(upgrade.intake), "upgrade_attempt_id": str(upgrade.attempt_id)}


def provenance(upgrade: PcbFormatUpgrade) -> dict:
    """What the user sees: upgraded from KiCad N format, by exactly which tool and argv."""
    report = json.loads(bytes(upgrade.canonical))
    attempt = upgrade.attempt
    original = attempt.intake.source_revision
    return {
        "upgrade_id": str(upgrade.id),
        "label": f"Upgraded from KiCad {upgrade.from_kicad_major} format",
        "from_kicad_major": upgrade.from_kicad_major,
        "from_format_version": upgrade.from_format_version,
        "to_format_version": upgrade.to_format_version,
        "tool_version": upgrade.tool_version,
        "image": upgrade.image,
        "recipe_id": attempt.build.recipe_id,
        "build_id": str(attempt.build_id),
        "upgrade_attempt_id": str(attempt.id),
        "original_intake_id": str(attempt.intake_id),
        "original_source_revision_id": str(original.id),
        "original_manifest_sha256": original.manifest_sha256,
        "report_sha256": upgrade.sha256,
        "files": report["files"],
        "unsupported": report["unsupported"],
        "accepted_at": upgrade.created_at.isoformat(),
    }


def upgrade_section(intake: PcbIntake) -> dict | None:
    """Offer and history of the recorded upgrade for an original (non-upgraded) intake."""
    if not intake.board_path or hasattr(intake.source_revision, "pcb_format_upgrade"):
        return None
    from specmate.pcb.operations import failure_diagnostic_for

    attempts = []
    for attempt in intake.upgrades.select_related("build__stage").order_by("created_at"):
        accepted = PcbFormatUpgrade.objects.filter(attempt=attempt).first()
        attempts.append(
            {
                "upgrade_attempt_id": str(attempt.id),
                "build_id": str(attempt.build_id),
                "state": attempt.build.stage.state,
                "diagnostic": failure_diagnostic_for(
                    attempt.build.stage, intake.source_revision_id, UPGRADE_REPORT_PATH
                ),
                "derived_intake_id": str(accepted.intake_id) if accepted else None,
                "derived_source_revision_id": str(accepted.revision_id) if accepted else None,
            }
        )
    return {
        "available_recipe_id": available_upgrade_recipe(intake),
        "upgradable_kicad_majors": UPGRADABLE_MAJORS,
        "attempts": attempts,
    }
