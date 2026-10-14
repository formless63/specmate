"""Controlled native evidence acceptance through registered build outputs only."""

import hashlib
import json
from typing import Literal
from uuid import UUID

from pydantic import Field, ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import StrictModel
from specmate.builds.models import BuildStage
from specmate.builds.operations import RequestBuild, request_build
from specmate.builds.recipes import Recipe, approved_recipe
from specmate.design.operations import canonical_bytes
from specmate.operations import NotFound, Unsupported, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope
from specmate.pcb_disagreement.contracts import FilePin
from specmate.pcb_disagreement.models import SourceNetAttempt, SourceNetInterpretation
from specmate.pcb_disagreement.native_report import NativeReport
from specmate.pcb_disagreement.pack import REPORT_PATH, XML_PATH, recipe_for
from specmate.pcb_disagreement.xml_extract import MAX_XML_BYTES
from specmate.queries import get_bundle_revision
from specmate.sources import blobstore


class RequestNative(StrictModel):
    project_id: UUID
    source: FilePin
    source_role: Literal["schematic", "netlist"]
    recipe_id: str = Field(min_length=1, max_length=128)


class AcceptNative(StrictModel):
    attempt_id: UUID


class ReadNative(StrictModel):
    interpretation_id: UUID


def authorize_bundle(user, revision_id):
    revision = get_bundle_revision(user, revision_id)
    for file in revision.files.select_related("blob"):
        authorize(user, file.blob.workspace_id, Perm.WORKSPACE_READ)
    return revision


def request_source(ctx, p):
    workspace = authorize(ctx.user, p.project_id, Perm.BUILD_EXECUTE)
    revision = authorize_bundle(ctx.user, p.source.source_revision_id)
    if revision.bundle.workspace_id != workspace.id:
        raise ValidationFailed("Native extraction workspace must hold the source revision.")
    from specmate.pcb_disagreement.queries import read_source

    return read_source(ctx.user, p.source)


def scoped_attempt(user, attempt_id, permission=Perm.WORKSPACE_READ):
    attempt = (
        SourceNetAttempt.objects.select_related(
            "source_file__revision__bundle", "source_file__blob", "build__source_revision__bundle"
        )
        .filter(id=attempt_id)
        .first()
    )
    if attempt is None:
        raise NotFound("Source net extraction attempt unavailable.")
    authorize(user, attempt.build.workspace_id, permission)
    authorize_bundle(user, attempt.source_file.revision_id)
    authorize_bundle(user, attempt.build.source_revision_id)
    for output in attempt.build.stage.outputs.select_related("source_revision__bundle"):
        authorize_bundle(user, output.source_revision_id)
    return attempt


def scoped_interpretation(user, interpretation_id):
    item = (
        SourceNetInterpretation.objects.select_related(
            "attempt", "output__stage__build", "xml_output__stage__build"
        )
        .filter(id=interpretation_id)
        .first()
    )
    if item is None:
        raise NotFound("Source net interpretation unavailable.")
    scoped_attempt(user, item.attempt_id)
    for output in (item.output, item.xml_output):
        authorize(user, output.stage.build.workspace_id, Perm.WORKSPACE_READ)
        authorize_bundle(user, output.source_revision_id)
    return item


def source_pin(file):
    return {
        "source_revision_id": str(file.revision_id),
        "manifest_sha256": file.revision.manifest_sha256,
        "path": file.path,
        "sha256": file.blob.sha256,
        "rights": file.rights,
    }


def interpretation_result(item):
    return {
        "interpretation_id": str(item.id),
        "attempt_id": str(item.attempt_id),
        "report_sha256": item.sha256,
        "output_id": str(item.output_id),
        "xml_output_id": str(item.xml_output_id),
        "source": source_pin(item.attempt.source_file),
        "report": json.loads(bytes(item.canonical)),
    }


def check_recipe(file, role, recipe):
    expected = Recipe.model_validate(recipe_for(file.path, file.rights, role))
    if recipe.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise Unsupported("Recipe differs from the exact pinned source-net extraction program.")


def scope(ctx, p):
    if isinstance(p, RequestNative):
        request_source(ctx, p)
        namespace = workspace_scope(ctx, p.project_id, Perm.BUILD_EXECUTE)
        name = "pcb_disagreement.request_native"
    else:
        attempt = scoped_attempt(ctx.user, p.attempt_id, Perm.SOURCE_REGISTER)
        namespace = workspace_scope(ctx, attempt.build.workspace_id, Perm.SOURCE_REGISTER)
        name = "pcb_disagreement.accept_native"
    # The executor deliberately diagnoses mismatches before invoking replay hooks.
    # Authorize old outcomes here even when the new payload selects another source.
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation=name,
            key=ctx.idempotency_key,
            scope=namespace,
        ):
            if isinstance(p, RequestNative):
                scoped_attempt(ctx.user, record.result["attempt_id"], Perm.BUILD_EXECUTE)
            else:
                item = scoped_interpretation(ctx.user, record.result["interpretation_id"])
                scoped_attempt(ctx.user, item.attempt_id, Perm.SOURCE_REGISTER)
    return namespace


def replay(ctx, p, stored):
    if isinstance(p, RequestNative):
        file = request_source(ctx, p)
        attempt = scoped_attempt(ctx.user, stored["attempt_id"], Perm.BUILD_EXECUTE)
        from specmate.pcb_disagreement.queries import validate_source

        validate_source(p.source, file)
        check_recipe(file, p.source_role, approved_recipe(p.recipe_id))
        if attempt.source_file_id != file.id or attempt.source_role != p.source_role:
            raise ValidationFailed("Stored extraction request differs from its source.")
        check_recipe(file, p.source_role, Recipe.model_validate(attempt.build.recipe))
    else:
        item = scoped_interpretation(ctx.user, stored["interpretation_id"])
        attempt = scoped_attempt(ctx.user, p.attempt_id, Perm.SOURCE_REGISTER)
        if item.attempt_id != attempt.id:
            raise ValidationFailed("Stored native acceptance differs from its attempt.")
        validate_outputs(attempt)


@operation(
    "pcb_disagreement.request_native",
    RequestNative,
    idempotency_scope=scope,
    authorize_replay=replay,
    status="accepted_async",
    summary="Request exact schematic/netlist extraction through an approved isolated recipe.",
)
def request_native(ctx, p):
    file = request_source(ctx, p)
    from specmate.pcb_disagreement.queries import validate_source

    validate_source(p.source, file)
    check_recipe(file, p.source_role, approved_recipe(p.recipe_id))
    result = request_build(
        ctx,
        RequestBuild(
            project_id=p.project_id,
            source_revision_id=p.source.source_revision_id,
            recipe_id=p.recipe_id,
        ),
    )
    attempt = SourceNetAttempt.objects.create(
        source_file=file, source_role=p.source_role, build_id=result["build_id"]
    )
    return {"attempt_id": str(attempt.id), **result}


def read_output(output):
    with blobstore.open_blob(output.sha256) as stream:
        raw = stream.read(MAX_XML_BYTES + 1)
    if len(raw) != output.size or hashlib.sha256(raw).hexdigest() != output.sha256:
        raise ValidationFailed("Stored extraction bytes differ from the registered output.")
    return raw


def validate_outputs(attempt):
    file, build = attempt.source_file, attempt.build
    check_recipe(file, attempt.source_role, Recipe.model_validate(build.recipe))
    if build.recipe_id != build.recipe.get("id"):
        raise ValidationFailed("Stored build recipe identifier is inconsistent.")
    if (
        build.source_revision_id != file.revision_id
        or build.workspace_id != file.revision.bundle.workspace_id
    ):
        raise ValidationFailed("Extraction build differs from the owning source.")
    stage = BuildStage.objects.select_for_update().get(build=build)
    outputs = {o.path: o for o in stage.outputs.all()}
    if stage.state != "succeeded" or set(outputs) != {REPORT_PATH, XML_PATH}:
        raise ValidationFailed(
            "Extraction requires a successful registered JSON and XML output pair."
        )
    receipt = stage.receipt or {}
    expected = [{"path": p, "sha256": o.sha256} for p, o in sorted(outputs.items())]
    if (
        receipt.get("outcome") != "succeeded"
        or receipt.get("exit_code") != 0
        or sorted(receipt.get("outputs", []), key=lambda o: o.get("path", "")) != expected
    ):
        raise ValidationFailed("Successful extraction receipt differs from registered outputs.")
    for path, media in ((REPORT_PATH, "application/json"), (XML_PATH, "application/xml")):
        output = outputs[path]
        if (
            output.source_revision_id != file.revision_id
            or output.rights != file.rights
            or output.media_type != media
            or output.size > MAX_XML_BYTES
        ):
            raise ValidationFailed("Extraction output provenance is invalid.")
    json_bytes, xml_bytes = read_output(outputs[REPORT_PATH]), read_output(outputs[XML_PATH])
    try:
        report = NativeReport.model_validate_json(json_bytes)
    except ValidationError:
        raise ValidationFailed("Native extraction report is invalid or unsupported.") from None
    if (
        report.source_sha256 != file.blob.sha256
        or report.xml_sha256 != outputs[XML_PATH].sha256
        or report.source_role != attempt.source_role
    ):
        raise ValidationFailed(
            "Native report source/XML hashes or role differ from registered evidence."
        )
    if (
        report.source_role == "netlist"
        and hashlib.sha256(xml_bytes).hexdigest() != file.blob.sha256
    ):
        raise ValidationFailed("Preserved netlist XML differs from its original bytes.")
    return outputs, report


@operation(
    "pcb_disagreement.accept_native",
    AcceptNative,
    idempotency_scope=scope,
    authorize_replay=replay,
    summary="Accept exact successful native outputs without selecting an authoritative source.",
)
def accept_native(ctx, p):
    attempt = scoped_attempt(ctx.user, p.attempt_id, Perm.SOURCE_REGISTER)
    outputs, report = validate_outputs(attempt)
    canonical = canonical_bytes(report.model_dump(mode="json"))
    item, _ = SourceNetInterpretation.objects.get_or_create(
        attempt=attempt,
        defaults={
            "output": outputs[REPORT_PATH],
            "xml_output": outputs[XML_PATH],
            "canonical": canonical,
            "sha256": hashlib.sha256(canonical).hexdigest(),
            "accepted_by": ctx.user,
        },
    )
    return interpretation_result(item)


@operation(
    "pcb_disagreement.read_native",
    ReadNative,
    supports_idempotency=False,
    summary="Read an exact currently authorized accepted source-net interpretation.",
)
def read_native(ctx, p):
    return interpretation_result(scoped_interpretation(ctx.user, p.interpretation_id))


def list_native(user, project_id):
    workspace = authorize(user, project_id, Perm.WORKSPACE_READ)
    results = []
    for attempt in SourceNetAttempt.objects.filter(build__workspace=workspace).order_by(
        "-created_at"
    )[:100]:
        try:
            attempt = scoped_attempt(user, attempt.id)
        except NotFound:
            continue
        item = SourceNetInterpretation.objects.filter(attempt=attempt).first()
        results.append(
            {
                "attempt_id": str(attempt.id),
                "source": source_pin(attempt.source_file),
                "source_role": attempt.source_role,
                "build_id": str(attempt.build_id),
                "state": attempt.build.stage.state,
                "interpretation": (
                    {"interpretation_id": str(item.id), "report_sha256": item.sha256}
                    if item
                    else None
                ),
            }
        )
    return {"attempts": results, "limit": 100}


def project_interpretation(item):
    if hashlib.sha256(bytes(item.canonical)).hexdigest() != item.sha256:
        raise ValidationFailed("Accepted source-net report hash is inconsistent.")
    report = NativeReport.model_validate_json(bytes(item.canonical))
    return {
        "method": report.method,
        "source_role": report.source_role,
        "property_owner": "preserved_source",
        "source": source_pin(item.attempt.source_file),
        "coverage": report.coverage,
        "coverage_basis": "Observed root unit pin inventory; omitted memberships remain unknown",
        "extractor": {
            "adapter": report.adapter,
            "tool_version": report.tool_version,
            "interpretation_id": str(item.id),
            "report_sha256": item.sha256,
            "build_id": str(item.attempt.build_id),
            "output_id": str(item.output_id),
            "xml_sha256": report.xml_sha256,
            "reported_source_tool": report.reported_source_tool,
        },
        "terminals": [terminal.model_dump(mode="json") for terminal in report.terminals],
        "unsupported": report.unsupported,
    }


def native_options(user, revision_id, path, role):
    revision = authorize_bundle(user, revision_id)
    file = revision.files.select_related("blob").filter(path=path).first()
    if file is None:
        raise NotFound("Source extraction file unavailable.")
    if role not in {"schematic", "netlist"}:
        raise ValidationFailed("Select schematic or netlist extraction.")
    try:
        expected = recipe_for(file.path, file.rights, role)
        recipe = approved_recipe(expected["id"])
        check_recipe(file, role, recipe)
    except (ValueError, Unsupported, ValidationFailed):
        return {"available_recipe_id": None}
    return {"available_recipe_id": recipe.id}
