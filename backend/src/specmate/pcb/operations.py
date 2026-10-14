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
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    canonical_bytes,
    create_definition,
    freeze_draft,
    scoped_draft,
    update_draft,
)
from specmate.operations import Context, NotFound, Unsupported, ValidationFailed, operation
from specmate.operations.scope import WorkspacePayload
from specmate.pcb.models import PcbExtractionAttempt, PcbIntake, PcbInterpretation
from specmate.pcb.pack import MAX_REPORT_BYTES, REPORT_PATH, recipe_for
from specmate.pcb.population import Population, closure, project_population, scoped_interpretation
from specmate.pcb.report import Report
from specmate.sources import blobstore
from specmate.sources.models import SourceBundleRevision


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegisterIntake(WorkspacePayload):
    source_revision_id: UUID
    board_path: str = Field(default="", max_length=512)

    @field_validator("board_path")
    @classmethod
    def portable_path(cls, value):
        return check_package_path(value) if value else value


def intake_for(ctx, intake_id, perm=Perm.WORKSPACE_READ):
    intake = (
        PcbIntake.objects.select_related("source_revision__bundle").filter(id=intake_id).first()
    )
    if intake is None:
        raise NotFound("PCB intake not found.")
    authorize(ctx.user, intake.source_revision.bundle.workspace_id, perm)
    return intake


def intake_result(intake):
    interpretation = (
        PcbInterpretation.objects.filter(attempt__intake=intake).order_by("-created_at").first()
    )
    report = json.loads(bytes(interpretation.canonical)) if interpretation else None
    available_recipe_id = None
    board = intake.source_revision.files.filter(path=intake.board_path).first()
    if board is not None:
        expected = recipe_for(intake.board_path, board.rights)
        try:
            approved = approved_recipe(expected["id"])
            validate_recipe(intake, approved)
            available_recipe_id = approved.id
        except (Unsupported, ValidationFailed):
            # Preserved-source reads remain usable without native execution configured.
            pass
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
        "workspace_id": str(intake.source_revision.bundle.workspace_id),
        "source_revision_id": str(intake.source_revision_id),
        "source_manifest_sha256": intake.source_revision.manifest_sha256,
        "board_path": intake.board_path,
        "available_recipe_id": available_recipe_id,
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
    idempotency_scope=lambda ctx, p: pcb_scope(ctx, p),
    authorize_replay=lambda ctx, p, stored: authorize_pcb_replay(ctx, p, stored),
    summary="Preserve a source revision for PCB intake without parsing or executing it.",
)
def register_intake(ctx: Context, p: RegisterIntake):
    workspace = authorize(ctx.user, p.workspace_id, Perm.SOURCE_REGISTER)
    source = SourceBundleRevision.objects.filter(
        id=p.source_revision_id, bundle__workspace=workspace
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
    idempotency_scope=lambda ctx, p: pcb_scope(ctx, p),
    authorize_replay=lambda ctx, p, stored: authorize_pcb_replay(ctx, p, stored),
    status="accepted_async",
    summary="Request the pinned isolated PCB interpretation from an exact preserved revision.",
)
def request_extraction(ctx: Context, p: RequestExtraction):
    intake = intake_for(ctx, p.intake_id, Perm.BUILD_EXECUTE)
    validate_recipe(intake, approved_recipe(p.recipe_id))
    build = request_build(
        ctx,
        RequestBuild(
            workspace_id=intake.source_revision.bundle.workspace_id,
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
    idempotency_scope=lambda ctx, p: pcb_scope(ctx, p),
    authorize_replay=lambda ctx, p, stored: authorize_pcb_replay(ctx, p, stored),
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
        or attempt.build.workspace_id != intake.source_revision.bundle.workspace_id
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
    "pcb.get",
    IntakeRef,
    summary="Read preserved PCB intake and scoped native interpretations.",
    supports_idempotency=False,
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
        workspace = authorize(ctx.user, payload.workspace_id, Perm.SOURCE_REGISTER)
        if not SourceBundleRevision.objects.filter(
            id=payload.source_revision_id, bundle__workspace=workspace
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
            or attempt.build.workspace_id != intake.source_revision.bundle.workspace_id
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


def pcb_scope(ctx, payload):
    from specmate.operations.scope import workspace_scope

    if isinstance(payload, RegisterIntake):
        scope = workspace_scope(ctx, payload.workspace_id, Perm.SOURCE_REGISTER)
        if not SourceBundleRevision.objects.filter(
            id=payload.source_revision_id, bundle__workspace_id=scope.removeprefix("workspace:")
        ).exists():
            raise NotFound("Source revision not found.")
        return scope
    if isinstance(payload, RequestExtraction):
        intake = intake_for(ctx, payload.intake_id, Perm.BUILD_EXECUTE)
    elif isinstance(payload, AttemptRef):
        attempt = PcbExtractionAttempt.objects.filter(id=payload.attempt_id).first()
        if attempt is None:
            raise NotFound("PCB extraction attempt not found.")
        intake = intake_for(ctx, attempt.intake_id, Perm.SOURCE_REGISTER)
    else:
        raise Unsupported("PCB scope payload is unsupported.")
    return workspace_scope(ctx, intake.source_revision.bundle.workspace_id)


class CreatePopulation(Payload):
    interpretation_id: UUID
    name: str = Field(min_length=1, max_length=200)


class UpdatePopulation(Payload):
    draft_id: UUID
    population: Population


class PopulationDraftRef(Payload):
    draft_id: UUID


class ReadPopulation(PopulationDraftRef):
    option_id: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


def population_draft(ctx, draft_id, permission=Perm.WORKSPACE_READ, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != "pcb_population":
        raise NotFound("PCB population draft not found.")
    closure(ctx.user, draft.definition, draft.content)
    return draft


def population_scope(ctx, payload, permission=Perm.DESIGN_EDIT):
    from specmate.operations.scope import workspace_scope

    if isinstance(payload, CreatePopulation):
        interpretation = (
            PcbInterpretation.objects.select_related("attempt__intake__source_revision__bundle")
            .filter(id=payload.interpretation_id)
            .first()
        )
        if interpretation is None:
            raise NotFound("PCB interpretation not found.")
        workspace_id = interpretation.attempt.intake.source_revision.bundle.workspace_id
        scoped_interpretation(ctx.user, workspace_id, payload.interpretation_id)
    else:
        workspace_id = population_draft(ctx, payload.draft_id, permission).definition.workspace_id
    return workspace_scope(ctx, workspace_id, permission)


def population_replay(ctx, payload, stored, permission=Perm.DESIGN_EDIT):
    population_scope(ctx, payload, permission)
    if isinstance(payload, CreatePopulation):
        from specmate.design.models import Draft

        draft = Draft.objects.select_related("definition").filter(id=stored["draft_id"]).first()
        if draft is None or draft.definition.kind != "pcb_population":
            raise ValidationFailed("Saved PCB population draft is unavailable.")
        closure(ctx.user, draft.definition, draft.content)
    else:
        draft = population_draft(ctx, payload.draft_id, permission)
        if isinstance(payload, UpdatePopulation):
            closure(
                ctx.user,
                draft.definition,
                {"pcb_population": payload.population.model_dump(mode="json")},
            )
    if "content" in stored:
        closure(ctx.user, draft.definition, stored["content"])
    if "revision_id" in stored:
        from specmate.queries import get_revision

        get_revision(ctx.user, stored["revision_id"])


@operation(
    "pcb.population_create",
    CreatePopulation,
    summary="Create explicit PCB population options for an exact accepted interpretation.",
    authorize_replay=population_replay,
    idempotency_scope=population_scope,
)
def create_population(ctx: Context, p: CreatePopulation):
    interpretation = (
        PcbInterpretation.objects.select_related("attempt__intake__source_revision__bundle")
        .filter(id=p.interpretation_id)
        .first()
    )
    if interpretation is None:
        raise NotFound("PCB interpretation not found.")
    source = interpretation.attempt.intake.source_revision
    scoped_interpretation(ctx.user, source.bundle.workspace_id, p.interpretation_id)
    authorize(ctx.user, source.bundle.workspace_id, Perm.DESIGN_EDIT)
    report = Report.model_validate_json(bytes(interpretation.canonical))
    population = Population(
        interpretation_id=interpretation.id,
        interpretation_sha256=interpretation.sha256,
        source_revision_id=source.id,
        source_manifest_sha256=source.manifest_sha256,
        options=[
            {
                "local_id": "default",
                "name": "Default",
                "decisions": [{"component_id": c.id} for c in report.components],
            }
        ],
    )
    return create_definition(
        ctx,
        CreateDefinition(
            workspace_id=source.bundle.workspace_id,
            kind="pcb_population",
            name=p.name,
            content={"pcb_population": population.model_dump(mode="json")},
        ),
    )


@operation(
    "pcb.population_update",
    UpdatePopulation,
    summary="Update reviewed PCB population decisions using the shared draft token.",
    requires_expected_state=True,
    authorize_replay=population_replay,
    idempotency_scope=population_scope,
)
def update_population(ctx: Context, p: UpdatePopulation):
    draft = population_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    content = {"pcb_population": p.population.model_dump(mode="json")}
    closure(ctx.user, draft.definition, content)
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=content))


@operation(
    "pcb.population_freeze",
    PopulationDraftRef,
    summary="Freeze exact population options and all reviewed candidate dependencies.",
    requires_expected_state=True,
    authorize_replay=lambda ctx, p, stored: population_replay(ctx, p, stored, Perm.DESIGN_FREEZE),
    idempotency_scope=lambda ctx, p: population_scope(ctx, p, Perm.DESIGN_FREEZE),
)
def freeze_population(ctx: Context, p: PopulationDraftRef):
    draft = population_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE, lock=True)
    return freeze_draft(
        ctx,
        CaptureDraft(
            draft_id=p.draft_id,
            dependencies=closure(ctx.user, draft.definition, draft.content),
        ),
    )


@operation(
    "pcb.population_read",
    ReadPopulation,
    summary="Read one scoped population draft and its selected-option projection.",
    supports_idempotency=False,
)
def read_population(ctx: Context, p: ReadPopulation):
    draft = population_draft(ctx, p.draft_id)
    population = Population.model_validate(draft.content["pcb_population"])
    interpretation = scoped_interpretation(
        ctx.user, draft.definition.workspace_id, population.interpretation_id
    )
    report = Report.model_validate_json(bytes(interpretation.canonical))
    return {
        "definition_id": str(draft.definition_id),
        "draft_id": str(draft.id),
        "state": draft.state_token,
        "content": draft.content,
        "projection": project_population(population, report, p.option_id) if p.option_id else None,
    }
