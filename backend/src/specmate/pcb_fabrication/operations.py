"""Shared commands over preserved intake and existing immutable build evidence."""

import hashlib
import json
from uuid import UUID

from pydantic import Field, ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import StrictModel
from specmate.builds.models import BuildAttempt
from specmate.builds.operations import RequestBuild, request_build
from specmate.builds.recipes import Recipe, approved_recipe
from specmate.operations import NotFound, Unsupported, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import LEGACY_SCOPE, project_scope
from specmate.pcb.models import PcbInterpretation
from specmate.pcb.operations import intake_for
from specmate.pcb.report import Report as IntakeReport
from specmate.pcb_disagreement.native_operations import authorize_bundle
from specmate.pcb_fabrication.pack import MAX_OUTPUT_BYTES, OUTPUT_MEDIA, REPORT_PATH, recipe_for
from specmate.pcb_fabrication.report import Report
from specmate.sources import blobstore


class IntakeRef(StrictModel):
    intake_id: UUID


class RequestFabrication(IntakeRef):
    recipe_id: str = Field(min_length=1, max_length=128)


class BuildRef(IntakeRef):
    build_id: UUID


def source_for(ctx, intake_id, permission=Perm.PROJECT_READ):
    intake = intake_for(ctx, intake_id, permission)
    authorize_bundle(ctx.user, intake.source_revision_id)
    file = (
        intake.source_revision.files.select_related("blob").filter(path=intake.board_path).first()
    )
    if file is None:
        raise NotFound("Selected preserved board unavailable.")
    return intake, file


def check_recipe(file, recipe):
    expected = Recipe.model_validate(recipe_for(file.path, file.rights))
    if recipe.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise Unsupported("Recipe differs from the exact pinned fabrication program.")


def qualified_intake(ctx, intake, file):
    item = PcbInterpretation.objects.filter(attempt__intake=intake).order_by("-created_at").first()
    if item is None:
        raise Unsupported("An accepted native intake interpretation is required.")
    authorize(ctx.user, item.output.stage.build.project_id, Perm.PROJECT_READ)
    authorize_bundle(ctx.user, item.output.source_revision_id)
    if hashlib.sha256(bytes(item.canonical)).hexdigest() != item.sha256:
        raise ValidationFailed("Accepted native intake hash is inconsistent.")
    try:
        report = IntakeReport.model_validate_json(bytes(item.canonical))
    except ValidationError:
        raise ValidationFailed("Accepted native intake is invalid.") from None
    if report.source_sha256 != file.blob.sha256:
        raise ValidationFailed("Accepted intake differs from the exact preserved source.")
    if not report.outline or report.coverage.outline != "closed-line-polygons":
        raise Unsupported("Fabrication requires a qualified closed line outline.")
    if any(c.dnp for c in report.components):
        raise Unsupported("Native DNP export behavior is unqualified; preserve the original.")
    if intake.source_revision.files.filter(path__iregex=r"\.(kicad_pro|kicad_dru)$").exists():
        raise Unsupported(
            "Custom project rules/settings are unqualified; standalone board required."
        )
    return item


def scoped_build(ctx, intake_id, build_id, permission=Perm.PROJECT_READ):
    intake, file = source_for(ctx, intake_id, permission)
    build = BuildAttempt.objects.select_related("stage").filter(id=build_id).first()
    if build is None:
        raise NotFound("Fabrication build unavailable.")
    authorize(ctx.user, build.project_id, permission)
    authorize_bundle(ctx.user, build.source_revision_id)
    for output in build.stage.outputs.all():
        authorize_bundle(ctx.user, output.source_revision_id)
    if (
        build.project_id != intake.source_revision.bundle.project_id
        or build.source_revision_id != file.revision_id
    ):
        raise NotFound("Fabrication build unavailable for this exact intake.")
    try:
        check_recipe(file, Recipe.model_validate(build.recipe))
    except ValidationError:
        raise ValidationFailed("Stored fabrication recipe is invalid.") from None
    if build.recipe_id != build.recipe.get("id"):
        raise ValidationFailed("Stored fabrication recipe identifier is inconsistent.")
    return intake, file, build


def retained(ctx, stored):
    scoped_build(ctx, stored["intake_id"], stored["build_id"], Perm.BUILD_EXECUTE)


def scope(ctx, p):
    intake, file = source_for(ctx, p.intake_id, Perm.BUILD_EXECUTE)
    namespace = project_scope(ctx, intake.source_revision.bundle.project_id, Perm.BUILD_EXECUTE)
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation="pcb_fabrication.request",
            key=ctx.idempotency_key,
            scope__in=[namespace, LEGACY_SCOPE],
        ):
            retained(ctx, record.result)
    qualified_intake(ctx, intake, file)
    return namespace


def replay(ctx, p, stored):
    retained(ctx, stored)
    intake, file = source_for(ctx, p.intake_id, Perm.BUILD_EXECUTE)
    qualified_intake(ctx, intake, file)
    check_recipe(file, approved_recipe(p.recipe_id))


@operation(
    "pcb_fabrication.request",
    RequestFabrication,
    status="accepted_async",
    idempotency_scope=scope,
    authorize_replay=replay,
    summary="Generate bounded native DRC, Gerber and drill evidence from an exact original board.",
)
def request(ctx, p):
    intake, file = source_for(ctx, p.intake_id, Perm.BUILD_EXECUTE)
    qualified_intake(ctx, intake, file)
    check_recipe(file, approved_recipe(p.recipe_id))
    result = request_build(
        ctx,
        RequestBuild(
            project_id=intake.source_revision.bundle.project_id,
            source_revision_id=file.revision_id,
            recipe_id=p.recipe_id,
        ),
    )
    return {"intake_id": str(intake.id), **result}


def output_bytes(output):
    with blobstore.open_blob(output.sha256) as stream:
        raw = stream.read(MAX_OUTPUT_BYTES + 1)
    if len(raw) != output.size or hashlib.sha256(raw).hexdigest() != output.sha256:
        raise ValidationFailed("Stored fabrication bytes differ from registered evidence.")
    return raw


def validate_outputs(file, build):
    stage = build.stage
    outputs = {o.path: o for o in stage.outputs.all()}
    if stage.state != "succeeded" or set(outputs) != set(OUTPUT_MEDIA):
        raise ValidationFailed("Review requires a successful complete registered output set.")
    expected = [{"path": p, "sha256": o.sha256} for p, o in sorted(outputs.items())]
    receipt = stage.receipt or {}
    if (
        receipt.get("outcome") != "succeeded"
        or receipt.get("exit_code") != 0
        or sorted(receipt.get("outputs", []), key=lambda o: o.get("path", "")) != expected
    ):
        raise ValidationFailed("Native receipt differs from registered fabrication outputs.")
    if sum(o.size for o in outputs.values()) > MAX_OUTPUT_BYTES:
        raise ValidationFailed("Registered fabrication output set exceeds its limit.")
    raw = {}
    for path, output in outputs.items():
        if (
            output.source_revision_id != file.revision_id
            or output.rights != file.rights
            or output.media_type != OUTPUT_MEDIA[path]
            or output.size <= 0
            or output.size > MAX_OUTPUT_BYTES
        ):
            raise ValidationFailed("Fabrication output provenance is invalid.")
        raw[path] = output_bytes(output)
    try:
        report = Report.model_validate_json(raw[REPORT_PATH])
        drc = json.loads(raw["drc.json"])
        counts = {k: len(drc[k]) for k in ("violations", "unconnected_items", "schematic_parity")}
        if any(not isinstance(drc[k], list) for k in counts):
            raise ValueError("Invalid DRC categories")
        if (
            drc.get("$schema") != "https://schemas.kicad.org/drc.v1.json"
            or drc.get("kicad_version") != "10.0.6"
            or drc.get("coordinate_units") != "mm"
            or counts["schematic_parity"] != 0
        ):
            raise ValueError("Unsupported DRC format or parity claim")
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
        raise ValidationFailed("Registered native fabrication/DRC report is invalid.") from None
    if report.source_sha256 != file.blob.sha256 or report.drc_counts.model_dump() != counts:
        raise ValidationFailed("Fabrication report differs from exact source or DRC evidence.")
    for item in report.outputs:
        output = outputs[item.path]
        if item.sha256 != output.sha256 or item.size != output.size:
            raise ValidationFailed("Fabrication manifest differs from registered bytes.")
    return report, outputs


@operation(
    "pcb_fabrication.read",
    BuildRef,
    supports_idempotency=False,
    summary="Review exact registered native output evidence without manufacturing approval.",
)
def read(ctx, p):
    intake, file, build = scoped_build(ctx, p.intake_id, p.build_id)
    report, outputs = validate_outputs(file, build)
    return {
        "intake_id": str(intake.id),
        "build_id": str(build.id),
        "source": {
            "source_revision_id": str(file.revision_id),
            "manifest_sha256": file.revision.manifest_sha256,
            "path": file.path,
            "sha256": file.blob.sha256,
            "rights": file.rights,
        },
        "recipe_id": build.recipe_id,
        "image": build.recipe["image"],
        "report_sha256": outputs[REPORT_PATH].sha256,
        "report": report.model_dump(mode="json"),
        "outputs": [
            {
                "output_id": str(o.id),
                "path": o.path,
                "sha256": o.sha256,
                "size": o.size,
                "media_type": o.media_type,
                "rights": o.rights,
            }
            for _, o in sorted(outputs.items())
        ],
    }


def options(ctx, intake_id):
    intake, file = source_for(ctx, intake_id)
    reason, recipe_id = None, None
    try:
        qualified_intake(ctx, intake, file)
        expected = recipe_for(file.path, file.rights)
        approved = approved_recipe(expected["id"])
        check_recipe(file, approved)
        recipe_id = approved.id
    except Unsupported as exc:
        reason = str(exc)
    builds = []
    for build in BuildAttempt.objects.filter(
        source_revision_id=file.revision_id, recipe_id=recipe_for(file.path, file.rights)["id"]
    ).order_by("-created_at")[:100]:
        scoped_build(ctx, intake_id, build.id)
        builds.append({"build_id": str(build.id), "state": build.stage.state})
    return {
        "available_recipe_id": recipe_id,
        "unavailable_reason": reason,
        "builds": builds,
        "limit": 100,
        "physical_qualification": False,
        "manufacturing_approval": False,
    }
