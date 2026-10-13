import hashlib
import json
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic import ValidationError as PydanticValidationError

from specmate.access.permissions import Perm, authorize
from specmate.builds.models import BuildStage
from specmate.builds.operations import RequestBuild, request_build
from specmate.builds.recipes import Recipe, approved_recipe
from specmate.contracts import check_package_path
from specmate.design.operations import canonical_bytes
from specmate.operations import Context, NotFound, Unsupported, ValidationFailed, operation
from specmate.pcb.models import PcbExtractionAttempt, PcbIntake, PcbInterpretation
from specmate.pcb.pack import MAX_REPORT_BYTES, REPORT_PATH, recipe_for
from specmate.pcb.report import Report
from specmate.sources import blobstore
from specmate.sources.models import SourceBundleRevision


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegisterIntake(Payload):
    project_id: UUID
    source_revision_id: UUID
    board_path: str = Field(default="", max_length=512)

    @field_validator("board_path")
    @classmethod
    def portable_path(cls, value):
        return check_package_path(value) if value else value


def intake_for(ctx, intake_id, perm=Perm.PROJECT_READ):
    intake = (
        PcbIntake.objects.select_related("source_revision__bundle").filter(id=intake_id).first()
    )
    if intake is None:
        raise NotFound("PCB intake not found.")
    authorize(ctx.user, intake.source_revision.bundle.project_id, perm)
    return intake


def intake_result(intake):
    interpretation = (
        PcbInterpretation.objects.filter(attempt__intake=intake).order_by("-created_at").first()
    )
    report = json.loads(bytes(interpretation.canonical)) if interpretation else None
    files = []
    for file in intake.source_revision.files.select_related("blob").order_by("path"):
        selected = file.path == intake.board_path
        files.append(
            {
                "path": file.path,
                "sha256": file.blob.sha256,
                "size": file.blob.size,
                "media_type": file.media_type,
                "rights": file.rights,
                "coverage": (
                    "parsed-native-subset" if report else "native-extraction-available-not-parsed"
                )
                if selected
                else "preserved-unparsed",
                "unsupported": (report["unsupported"] if report else None)
                if selected
                else "Semantic parsing of this input is unsupported by this adapter.",
            }
        )
    return {
        "intake_id": str(intake.id),
        "project_id": str(intake.source_revision.bundle.project_id),
        "source_revision_id": str(intake.source_revision_id),
        "source_manifest_sha256": intake.source_revision.manifest_sha256,
        "board_path": intake.board_path,
        "files": files,
        "support": {
            "tool_version": "10.0.6",
            "native_format_version": 20260206,
            "platform": "linux/amd64",
            "version_verified": report is not None,
        },
        "native_execution": "explicit-request-and-installed-approved-recipe-required",
        "physical_qualification": False,
    }


@operation(
    "pcb.register_intake",
    RegisterIntake,
    summary="Preserve a source revision for PCB intake without parsing or executing it.",
)
def register_intake(ctx: Context, p: RegisterIntake):
    project = authorize(ctx.user, p.project_id, Perm.SOURCE_REGISTER)
    source = SourceBundleRevision.objects.filter(
        id=p.source_revision_id, bundle__project=project
    ).first()
    if source is None:
        raise NotFound("Source revision not found.")
    if p.board_path:
        if not source.files.filter(path=p.board_path).exists():
            raise ValidationFailed("Selected board is not in the preserved revision.")
        if not p.board_path.lower().endswith(".kicad_pcb"):
            raise Unsupported(
                "Native extraction supports only .kicad_pcb; "
                "preserve other inputs without selecting a board."
            )
    intake, _ = PcbIntake.objects.get_or_create(
        source_revision=source, board_path=p.board_path, defaults={"created_by": ctx.user}
    )
    return intake_result(intake)


class IntakeRef(Payload):
    intake_id: UUID


class RequestExtraction(IntakeRef):
    recipe_id: str = Field(min_length=1, max_length=128)


def validate_recipe(intake, recipe):
    file = intake.source_revision.files.filter(path=intake.board_path).first()
    if file is None:
        raise Unsupported("This intake has no supported native board selected.")
    expected = Recipe.model_validate(recipe_for(intake.board_path, file.rights))
    if recipe.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise Unsupported("Approved recipe does not match the pinned PCB extraction adapter.")
    return file


@operation(
    "pcb.request_extraction",
    RequestExtraction,
    status="accepted_async",
    summary="Request the pinned isolated PCB interpretation from an exact preserved revision.",
)
def request_extraction(ctx: Context, p: RequestExtraction):
    intake = intake_for(ctx, p.intake_id, Perm.BUILD_EXECUTE)
    validate_recipe(intake, approved_recipe(p.recipe_id))
    build = request_build(
        ctx,
        RequestBuild(
            project_id=intake.source_revision.bundle.project_id,
            source_revision_id=intake.source_revision_id,
            recipe_id=p.recipe_id,
        ),
    )
    attempt = PcbExtractionAttempt.objects.create(intake=intake, build_id=build["build_id"])
    return {"intake_id": str(intake.id), "attempt_id": str(attempt.id), **build}


class AttemptRef(Payload):
    attempt_id: UUID


@operation(
    "pcb.accept_extraction",
    AttemptRef,
    summary="Validate a successful native report and retain its immutable source/build provenance.",
)
def accept_extraction(ctx: Context, p: AttemptRef):
    attempt = (
        PcbExtractionAttempt.objects.select_related("intake__source_revision__bundle", "build")
        .filter(id=p.attempt_id)
        .first()
    )
    if attempt is None:
        raise NotFound("PCB extraction attempt not found.")
    intake = intake_for(ctx, attempt.intake_id, Perm.SOURCE_REGISTER)
    file = validate_recipe(intake, Recipe.model_validate(attempt.build.recipe))
    if (
        attempt.build.source_revision_id != intake.source_revision_id
        or attempt.build.project_id != intake.source_revision.bundle.project_id
    ):
        raise ValidationFailed("Build provenance does not match intake.")
    stage = BuildStage.objects.select_for_update().get(build=attempt.build)
    if stage.state != "succeeded":
        raise ValidationFailed("Native extraction has no accepted successful receipt.")
    output = stage.outputs.filter(path=REPORT_PATH).first()
    if (
        output is None
        or output.source_revision_id != intake.source_revision_id
        or output.media_type != "application/json"
        or output.rights != file.rights
        or output.size > MAX_REPORT_BYTES
    ):
        raise ValidationFailed("Native output provenance is invalid.")
    if (
        stage.receipt.get("outcome") != "succeeded"
        or stage.receipt.get("exit_code") != 0
        or stage.receipt.get("outputs") != [{"path": output.path, "sha256": output.sha256}]
    ):
        raise ValidationFailed("Native successful receipt does not match the report output.")
    with blobstore.open_blob(output.sha256) as stream:
        content = stream.read(MAX_REPORT_BYTES + 1)
    if len(content) != output.size or hashlib.sha256(content).hexdigest() != output.sha256:
        raise ValidationFailed("Stored native report no longer matches its verified receipt.")
    try:
        report = Report.model_validate_json(content)
    except PydanticValidationError:
        raise ValidationFailed("Native report is invalid or unsupported.") from None
    if report.source_sha256 != file.blob.sha256:
        raise ValidationFailed("Native report refers to different board bytes.")
    canonical = canonical_bytes(report.model_dump(mode="json", by_alias=True))
    interpretation, _ = PcbInterpretation.objects.get_or_create(
        attempt=attempt,
        defaults={
            "output": output,
            "canonical": canonical,
            "sha256": hashlib.sha256(canonical).hexdigest(),
            "accepted_by": ctx.user,
        },
    )
    return interpretation_result(interpretation)


def interpretation_result(interpretation):
    return {
        "interpretation_id": str(interpretation.id),
        "attempt_id": str(interpretation.attempt_id),
        "output_id": str(interpretation.output_id),
        "sha256": interpretation.sha256,
        "report": json.loads(bytes(interpretation.canonical)),
    }


@operation(
    "pcb.get", IntakeRef, summary="Read preserved PCB intake and scoped native interpretations."
)
def get_intake(ctx: Context, p: IntakeRef):
    intake = intake_for(ctx, p.intake_id)
    result = intake_result(intake)
    result["attempts"] = [
        {
            "attempt_id": str(a.id),
            "build_id": str(a.build_id),
            "state": a.build.stage.state,
            "diagnostic": failure_diagnostic(a),
        }
        for a in intake.attempts.select_related("build__stage").order_by("created_at")
    ]
    result["interpretations"] = [
        interpretation_result(i)
        for i in PcbInterpretation.objects.filter(attempt__intake=intake).order_by("created_at")
    ]
    return result


def failure_diagnostic(attempt):
    """Only a bounded failed diagnostic, never failed geometry as accepted facts."""
    if attempt.build.stage.state != "failed":
        return None
    output = attempt.build.stage.outputs.filter(
        path=REPORT_PATH, media_type="application/json"
    ).first()
    if output is None or output.size > MAX_REPORT_BYTES:
        return "Native extraction failed without a diagnostic report."
    if output.source_revision_id != attempt.intake.source_revision_id:
        return "Native diagnostic provenance is invalid."
    try:
        with blobstore.open_blob(output.sha256) as stream:
            content = stream.read(MAX_REPORT_BYTES + 1)
        if len(content) != output.size or hashlib.sha256(content).hexdigest() != output.sha256:
            return "Native diagnostic receipt is invalid."
        diagnostic = json.loads(content)
    except (OSError, ValueError):
        return "Native diagnostic is unavailable."
    if not isinstance(diagnostic, dict) or diagnostic.get("status") != "failed":
        return "Native extraction failed; partial output is not an accepted interpretation."
    message = diagnostic.get("error")
    return message[:2000] if isinstance(message, str) else "Native extraction failed."


def authorize_pcb_replay(ctx: Context, payload: Payload, stored_result: dict):
    """Recheck scope before the shared layer returns a saved command response."""
    if isinstance(payload, RegisterIntake):
        project = authorize(ctx.user, payload.project_id, Perm.SOURCE_REGISTER)
        if not SourceBundleRevision.objects.filter(
            id=payload.source_revision_id, bundle__project=project
        ).exists():
            raise NotFound("Source revision not found.")
        intake = intake_for(ctx, stored_result["intake_id"], Perm.SOURCE_REGISTER)
        if intake.source_revision_id != payload.source_revision_id:
            raise ValidationFailed("Saved PCB intake provenance is invalid.")
    elif isinstance(payload, RequestExtraction):
        intake = intake_for(ctx, payload.intake_id, Perm.BUILD_EXECUTE)
        validate_recipe(intake, approved_recipe(payload.recipe_id))
        attempt = (
            PcbExtractionAttempt.objects.select_related("build")
            .filter(
                id=stored_result["attempt_id"], intake=intake, build_id=stored_result["build_id"]
            )
            .first()
        )
        if attempt is None or attempt.build.source_revision_id != intake.source_revision_id:
            raise ValidationFailed("Saved PCB extraction provenance is invalid.")
        validate_recipe(intake, Recipe.model_validate(attempt.build.recipe))
    elif isinstance(payload, AttemptRef):
        attempt = (
            PcbExtractionAttempt.objects.select_related("build__stage", "intake")
            .filter(id=payload.attempt_id)
            .first()
        )
        if attempt is None:
            raise NotFound("PCB extraction attempt not found.")
        intake = intake_for(ctx, attempt.intake_id, Perm.SOURCE_REGISTER)
        file = validate_recipe(intake, Recipe.model_validate(attempt.build.recipe))
        interpretation = (
            PcbInterpretation.objects.select_related("output")
            .filter(id=stored_result["interpretation_id"], attempt=attempt)
            .first()
        )
        if (
            interpretation is None
            or attempt.build.stage.state != "succeeded"
            or interpretation.output.source_revision_id != intake.source_revision_id
            or interpretation.output.rights != file.rights
            or interpretation.output_id != UUID(stored_result["output_id"])
            or attempt.build.source_revision_id != intake.source_revision_id
            or attempt.build.project_id != intake.source_revision.bundle.project_id
        ):
            raise ValidationFailed("Saved PCB interpretation provenance is invalid.")
        output = interpretation.output
        receipt = attempt.build.stage.receipt
        if (
            receipt.get("outcome") != "succeeded"
            or receipt.get("exit_code") != 0
            or receipt.get("outputs") != [{"path": output.path, "sha256": output.sha256}]
        ):
            raise ValidationFailed("Saved native receipt provenance is invalid.")
    elif isinstance(payload, IntakeRef):
        intake_for(ctx, payload.intake_id)
    else:
        raise Unsupported("PCB replay payload is unsupported.")
