"""Optional read-only inspection of sliced resin files with the UVtools pack.

The primary input is a ChiTuBox ``.ctb`` file (plain v2-v5 and the encrypted v4/v5
variants ChiTuBox writes); Elegoo ``.goo`` is secondary. The file must be preserved in a
registered source bundle. ChiTuBox ``.chitubox`` project files stay preserved source
attachments and are never parsed. Inspection reports what the file states and what UVtools
computes from its layers; it is never a printability claim and nothing reaches a printer.
"""

from __future__ import annotations

import hashlib

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.builds.models import BuildAttempt
from specmate.builds.operations import RequestBuild, request_build
from specmate.builds.recipes import Recipe, approved_recipe
from specmate.builds.rights import derive_for_revision
from specmate.catalog_matching.queries import current_actor
from specmate.operations import Context, NotFound, Unsupported, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope
from specmate.printing.contracts import (
    RequestResinInspection,
    ResinFileRef,
    ResinInspectionRef,
    ResinInspectionReport,
)
from specmate.printing.pack import (
    RESIN_ADAPTER,
    RESIN_MAX_OUTPUT_BYTES,
    RESIN_OUTPUTS,
    RESIN_REPORT_PATH,
    RESIN_SUFFIXES,
    RESIN_TOOL,
    canonical,
    resin_recipe_for,
    resin_recipe_id,
)
from specmate.queries import get_bundle_revision
from specmate.sources import blobstore
from specmate.sources.authority import authorize_revision
from specmate.sources.models import SourceBundleFile

STATUS = {
    "printable": "not_evaluated",
    "printer_submission": "not_available",
    "physical_qualification": False,
}


def resin_inputs(ctx, p: ResinFileRef, permission=Perm.WORKSPACE_READ):
    """The exact inspection input for one preserved file, or Unsupported."""
    bundle = get_bundle_revision(current_actor(ctx.user), p.source_revision_id)
    authorize(ctx.user, bundle.bundle.workspace_id, permission)
    stored = (
        SourceBundleFile.objects.select_related("blob").filter(revision=bundle, path=p.path).first()
    )
    if stored is None:
        raise NotFound("Resin file not found in this source revision.")
    lower = p.path.lower()
    if lower.endswith(".chitubox"):
        raise Unsupported(
            "ChiTuBox project files are preserved as source attachments and are not parsed; "
            "inspect the sliced .ctb file instead."
        )
    if not lower.endswith(RESIN_SUFFIXES):
        raise Unsupported("Only sliced .ctb (primary) and .goo resin files are inspected.")
    spec = {
        "adapter": RESIN_ADAPTER,
        "tool": RESIN_TOOL,
        "source_revision_id": str(bundle.id),
        "file": {
            "path": stored.path,
            "sha256": stored.blob.sha256,
            "size": stored.blob.size,
            "rights": stored.rights,
        },
    }
    return bundle, spec, derive_for_revision(bundle)


def checked_recipe(spec, rights, recipe):
    expected = Recipe.model_validate(resin_recipe_for(spec, recipe.image, rights))
    if recipe.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise Unsupported("Approved recipe differs from the exact inspection program or input.")


def scoped_inspection(ctx, p: ResinInspectionRef, permission=Perm.WORKSPACE_READ):
    bundle, spec, rights = resin_inputs(ctx, p, permission)
    build = BuildAttempt.objects.select_related("stage").filter(id=p.build_id).first()
    if build is None:
        raise NotFound("Resin inspection unavailable.")
    authorize(ctx.user, build.workspace_id, permission)
    actor = current_actor(ctx.user)
    authorize_revision(actor, build.source_revision)
    if (
        build.workspace_id != bundle.bundle.workspace_id
        or build.source_revision_id != bundle.id
        or build.recipe_id != resin_recipe_id(spec)
    ):
        raise NotFound("Resin inspection unavailable for this exact file.")
    try:
        checked_recipe(spec, rights, Recipe.model_validate(build.recipe))
    except ValidationError:
        raise ValidationFailed("Stored inspection recipe is invalid.") from None
    return spec, rights, build


def inspection_scope(ctx, p):
    bundle = get_bundle_revision(current_actor(ctx.user), p.source_revision_id)
    namespace = workspace_scope(ctx, bundle.bundle.workspace_id, Perm.BUILD_EXECUTE)
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation="print_resin_inspection.request",
            key=ctx.idempotency_key,
            scope=namespace,
        ):
            stored = record.result
            scoped_inspection(
                ctx,
                ResinInspectionRef(
                    source_revision_id=stored["source_revision_id"],
                    path=stored["path"],
                    build_id=stored["build_id"],
                ),
                Perm.BUILD_EXECUTE,
            )
    return namespace


def inspection_replay(ctx, p, stored):
    _, spec, rights = resin_inputs(ctx, p, Perm.BUILD_EXECUTE)
    checked_recipe(spec, rights, approved_recipe(p.recipe_id))


@operation(
    "print_resin_inspection.options",
    ResinFileRef,
    supports_idempotency=False,
    summary="Show the exact UVtools inspection recipe, availability and attempts for one "
    "preserved .ctb or .goo resin file; generating the recipe grants no execution.",
    access=Perm.WORKSPACE_READ,
)
def inspection_options(ctx: Context, p: ResinFileRef) -> dict:
    base = {"source_revision_id": str(p.source_revision_id), "path": p.path, "tool": RESIN_TOOL}
    try:
        bundle, spec, rights = resin_inputs(ctx, p)
    except Unsupported as exc:
        return {
            **base,
            "recipe_id": None,
            "available_recipe_id": None,
            "unavailable_reason": str(exc),
            "proposed_recipe": None,
            "builds": [],
            **STATUS,
        }
    rid, available, reason, builds = resin_recipe_id(spec), None, None, []
    try:
        checked_recipe(spec, rights, approved_recipe(rid))
        available = rid
    except Unsupported as exc:
        reason = str(exc)
    for build in (
        BuildAttempt.objects.select_related("stage")
        .filter(recipe_id=rid, source_revision_id=bundle.id)
        .order_by("-created_at")[:100]
    ):
        receipt = build.stage.receipt or {}
        builds.append(
            {
                "build_id": str(build.id),
                "state": build.stage.state,
                "failure": receipt.get("message") or receipt.get("reason")
                if build.stage.state in {"failed", "cancelled", "interrupted"}
                else None,
                "exit_code": receipt.get("exit_code"),
            }
        )
    return {
        **base,
        "recipe_id": rid,
        "available_recipe_id": available,
        "unavailable_reason": reason,
        "proposed_recipe": {**resin_recipe_for(spec, None, rights), "image": None},
        "builds": builds,
        **STATUS,
    }


@operation(
    "print_resin_inspection.request",
    RequestResinInspection,
    status="accepted_async",
    idempotency_scope=inspection_scope,
    authorize_replay=inspection_replay,
    summary="Inspect one preserved .ctb or .goo resin file with an approved isolated UVtools "
    "recipe. Reading a file is not printability; nothing is sent to a printer.",
    access=Perm.BUILD_EXECUTE,
)
def request_inspection(ctx: Context, p: RequestResinInspection) -> dict:
    bundle, spec, rights = resin_inputs(ctx, p, Perm.BUILD_EXECUTE)
    if p.recipe_id != resin_recipe_id(spec):
        raise Unsupported("Recipe is not the exact inspection recipe for this file.")
    checked_recipe(spec, rights, approved_recipe(p.recipe_id))
    result = request_build(
        ctx,
        RequestBuild(
            workspace_id=bundle.bundle.workspace_id,
            source_revision_id=bundle.id,
            recipe_id=p.recipe_id,
        ),
    )
    return {"source_revision_id": str(bundle.id), "path": p.path, **result}


def validate_inspection(spec, rights, build):
    """Accept only a complete registered output set matching the exact inspection report."""
    stage = build.stage
    outputs = {o.path: o for o in stage.outputs.all()}
    receipt = stage.receipt or {}
    expected = [{"path": p, "sha256": o.sha256} for p, o in sorted(outputs.items())]
    if (
        stage.state != "succeeded"
        or set(outputs) != set(RESIN_OUTPUTS)
        or receipt.get("outcome") != "succeeded"
        or receipt.get("exit_code") != 0
        or sorted(receipt.get("outputs", []), key=lambda o: o.get("path", "")) != expected
    ):
        raise ValidationFailed("Review requires a successful complete registered inspection.")
    raw = {}
    for path, output in outputs.items():
        if (
            output.source_revision_id != build.source_revision_id
            or output.rights != rights
            or output.media_type != RESIN_OUTPUTS[path]
            or not 0 < output.size <= RESIN_MAX_OUTPUT_BYTES
        ):
            raise ValidationFailed("Inspection output provenance is inconsistent.")
        with blobstore.open_blob(output.sha256) as stream:
            data = stream.read(RESIN_MAX_OUTPUT_BYTES + 1)
        if len(data) != output.size or hashlib.sha256(data).hexdigest() != output.sha256:
            raise ValidationFailed("Stored inspection bytes differ from registered evidence.")
        raw[path] = data
    tool = spec["tool"]
    try:
        report = ResinInspectionReport.model_validate_json(raw[RESIN_REPORT_PATH])
        listed = {o.path: o for o in report.outputs}
        if (
            report.input_sha256 != hashlib.sha256(canonical(spec)).hexdigest()
            or report.tool
            != {k: tool[k] for k in ("name", "package", "package_version", "release_sha256")}
            or report.file_sha256 != spec["file"]["sha256"]
            or set(listed) != set(RESIN_OUTPUTS) - {RESIN_REPORT_PATH}
            or len(listed) != len(report.outputs)
        ):
            raise ValueError("Report differs from the exact inspection input")
        for path, item in listed.items():
            if item.sha256 != outputs[path].sha256 or item.size != outputs[path].size:
                raise ValueError("Output hash differs")
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
        raise ValidationFailed("Registered inspection report is invalid.") from None
    return report, outputs


@operation(
    "print_resin_inspection.read",
    ResinInspectionRef,
    supports_idempotency=False,
    summary="Inspect registered UVtools evidence for one resin file: format, machine, "
    "layers, exposure, resolution, time and volume. Not printability or qualification.",
    access=Perm.WORKSPACE_READ,
)
def read_inspection(ctx: Context, p: ResinInspectionRef) -> dict:
    spec, rights, build = scoped_inspection(ctx, p)
    report, outputs = validate_inspection(spec, rights, build)
    return {
        "source_revision_id": str(p.source_revision_id),
        "path": p.path,
        "build_id": str(build.id),
        "inputs": spec,
        "recipe_id": build.recipe_id,
        "image": build.recipe["image"],
        "report_sha256": outputs[RESIN_REPORT_PATH].sha256,
        "report": report.model_dump(mode="json"),
        "outputs": [
            {
                "output_id": str(o.id),
                "path": path,
                "sha256": o.sha256,
                "size": o.size,
                "rights": o.rights,
                "media_type": o.media_type,
            }
            for path, o in sorted(outputs.items())
        ],
        **STATUS,
    }
