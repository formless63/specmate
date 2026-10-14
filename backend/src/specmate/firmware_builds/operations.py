"""Compile exact frozen declarations through the shared durable isolated build layer."""

import hashlib
import json
from contextvars import ContextVar
from uuid import UUID

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import get_snapshot
from specmate.builds.models import BuildAttempt
from specmate.builds.operations import RequestBuild, request_build
from specmate.builds.recipes import Recipe, approved_recipe
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Revision
from specmate.firmware_builds.contracts import (
    CompileRef,
    CompileReport,
    FirmwareRef,
    RequestCompile,
)
from specmate.firmware_builds.pack import (
    ADAPTER,
    MAX_OUTPUT_BYTES,
    OUTPUT_MEDIA,
    TOOL_PACKAGES,
    canonical,
    recipe_for,
    recipe_id,
    supported,
)
from specmate.operations import NotFound, PermissionDenied, Unsupported, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.pcb.firmware import read_revision
from specmate.queries import get_revision
from specmate.sources import blobstore
from specmate.sources.authority import authorize_revision
from specmate.sources.models import SourceBundleRevision

_REQUEST = ContextVar("firmware_compile_request", default=None)


def inputs(user, p, permission=Perm.WORKSPACE_READ):
    user = current_actor(user)
    read = read_revision(user, p.firmware_revision_id)
    revision = Revision.objects.get(id=p.firmware_revision_id)
    authorize(user, revision.definition.workspace_id, permission)
    occurrence = None
    if p.assembly_snapshot_id:
        snapshot, closure = get_snapshot(user, p.assembly_snapshot_id)
        authorize(user, snapshot.definition.workspace_id, permission)
        node = closure.nodes.get(tuple(p.path))
        if node is None:
            raise NotFound("Exact frozen board occurrence unavailable.")
        assignment = closure.assignments.get(tuple(p.path)) or node.occurrence.assignments
        if assignment.firmware_revision_id != p.firmware_revision_id or node.revision.id != UUID(
            read["content"]["firmware"]["target"]["population_revision_id"]
        ):
            raise ValidationFailed(
                "The selected firmware is not assigned to this exact frozen board occurrence."
            )
        occurrence = {
            "assembly_snapshot_id": str(snapshot.id),
            "assembly_snapshot_sha256": snapshot.sha256,
            "path": p.path,
            "population_revision_id": str(node.revision.id),
            "population_snapshot_sha256": node.revision.snapshot.sha256,
        }
    spec = {
        "adapter": ADAPTER,
        "firmware_revision_id": str(revision.id),
        "firmware_snapshot_sha256": read["snapshot_sha256"],
        "occurrence": occurrence,
        **read["content"]["firmware"],
    }
    return revision, read, spec


def executable_inputs(user, p, permission=Perm.WORKSPACE_READ):
    revision, read, spec = inputs(user, p, permission)
    supported(spec)
    if read["evaluation"]["readiness"] == "blocked":
        raise Unsupported("Invalid firmware declarations cannot be compiled.")
    source = SourceBundleRevision.objects.get(id=spec["sources"][0]["source_revision_id"])
    # The runner mounts the complete immutable revision; every mounted byte must be pinned.
    actual = {f.path: (f.blob.sha256, f.rights) for f in source.files.select_related("blob")}
    pinned = {f["path"]: (f["sha256"], f["rights"]) for f in spec["sources"][0]["files"]}
    if actual != pinned:
        raise Unsupported(
            "Pin the entire exact bundle before authorizing compiler source execution."
        )
    return revision, read, spec, source


def checked_recipe(spec, recipe):
    expected = Recipe.model_validate(recipe_for(spec, recipe.image))
    if recipe.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise Unsupported(
            "Approved recipe differs from the exact compiler program, target or inputs."
        )


def recipe_inputs(user, recipe, permission=Perm.WORKSPACE_READ):
    """Shared-build hook: authorize compiler source/board/occurrence closure at every lease."""
    if not recipe.id.startswith(ADAPTER + "-"):
        return None
    try:
        spec = json.loads(recipe.argv[-1])
        occurrence = spec["occurrence"]
        ref = FirmwareRef(
            firmware_revision_id=spec["firmware_revision_id"],
            assembly_snapshot_id=occurrence["assembly_snapshot_id"] if occurrence else None,
            path=occurrence["path"] if occurrence else [],
        )
    except (ValueError, TypeError, KeyError, ValidationError):
        raise ValidationFailed("Invalid compiler recipe input envelope.") from None
    _, _, expected, source = executable_inputs(user, ref, permission)
    checked_recipe(expected, recipe)
    return source


def authorize_request(ctx, p, recipe):
    """Shared build.request hook; prevents bypassing separate caller source consent."""
    source = recipe_inputs(ctx.user, recipe, Perm.BUILD_EXECUTE)
    if source is not None:
        if _REQUEST.get() != (p.source_revision_id, recipe.id):
            raise PermissionDenied(
                "Use firmware_build.request with explicit source-execution consent."
            )
        workspace = authorize(ctx.user, p.scope_id, Perm.BUILD_EXECUTE)
        if source.id != p.source_revision_id or source.bundle.workspace_id != workspace.id:
            raise ValidationFailed("Compiler build source differs from its exact firmware pin.")


def execution_allowed(build):
    recipe = Recipe.model_validate(build.recipe)
    source = recipe_inputs(build.requested_by, recipe, Perm.BUILD_EXECUTE)
    if source is not None and source.id != build.source_revision_id:
        raise ValidationFailed("Compiler execution source differs from its exact frozen input.")


def scoped_build(ctx, p, permission=Perm.WORKSPACE_READ):
    revision, _, spec = inputs(ctx.user, p, permission)
    build = (
        BuildAttempt.objects.select_related("stage", "source_revision__bundle")
        .filter(id=p.build_id)
        .first()
    )
    if build is None:
        raise NotFound("Compiler build unavailable.")
    authorize(ctx.user, build.workspace_id, permission)
    authorize_revision(current_actor(ctx.user), build.source_revision)
    for output in build.stage.outputs.select_related("source_revision__bundle"):
        authorize_revision(current_actor(ctx.user), output.source_revision)
    if build.workspace_id != revision.definition.workspace_id:
        raise NotFound("Compiler build unavailable for this firmware.")
    try:
        checked_recipe(spec, Recipe.model_validate(build.recipe))
    except ValidationError:
        raise ValidationFailed("Stored compiler recipe is invalid.") from None
    if (
        build.recipe_id != recipe_id(spec)
        or str(build.source_revision_id) != spec["sources"][0]["source_revision_id"]
    ):
        raise NotFound("Compiler build unavailable for these exact inputs.")
    return revision, spec, build


def retained(ctx, stored):
    return scoped_build(ctx, CompileRef.model_validate(stored["reference"]), Perm.BUILD_EXECUTE)


def scope(ctx, p):
    # Resolve only the owning firmware scope before retained evidence. Incoming
    # occurrence diagnostics must not bypass authority over an earlier build.
    revision = get_revision(current_actor(ctx.user), p.firmware_revision_id)
    authorize(ctx.user, revision.definition.workspace_id, Perm.BUILD_EXECUTE)
    if revision.definition.kind != "firmware":
        raise NotFound("Firmware revision unavailable.")
    namespace = f"workspace:{revision.definition.workspace_id}"
    for prior in IdempotencyRecord.objects.filter(
        actor=ctx.user,
        operation="firmware_build.request",
        key=ctx.idempotency_key,
        scope=namespace,
    ):
        retained(ctx, prior.result)
    inputs(ctx.user, p, Perm.BUILD_EXECUTE)
    return namespace


def replay(ctx, p, stored):
    retained(ctx, stored)
    _, _, spec, _ = executable_inputs(ctx.user, p, Perm.BUILD_EXECUTE)
    checked_recipe(spec, approved_recipe(p.recipe_id))


@operation(
    "firmware_build.request",
    RequestCompile,
    status="accepted_async",
    idempotency_scope=scope,
    authorize_replay=replay,
    summary="Compile an exact frozen firmware using an approved isolated toolchain; no flashing.",
)
def request(ctx, p):
    revision, _, spec, source = executable_inputs(ctx.user, p, Perm.BUILD_EXECUTE)
    checked_recipe(spec, approved_recipe(p.recipe_id))
    token = _REQUEST.set((source.id, p.recipe_id))
    try:
        result = request_build(
            ctx,
            RequestBuild(
                project_id=revision.definition.workspace_id,
                source_revision_id=source.id,
                recipe_id=p.recipe_id,
            ),
        )
    finally:
        _REQUEST.reset(token)
    reference = {
        **FirmwareRef.model_validate(
            p.model_dump(include=set(FirmwareRef.model_fields))
        ).model_dump(mode="json"),
        "build_id": result["build_id"],
    }
    return {**result, "reference": reference, "source_execution_authorized": True, "basis": p.basis}


def output_bytes(output):
    with blobstore.open_blob(output.sha256) as stream:
        raw = stream.read(MAX_OUTPUT_BYTES + 1)
    if len(raw) != output.size or hashlib.sha256(raw).hexdigest() != output.sha256:
        raise ValidationFailed("Registered compiler output bytes do not match their receipt.")
    return raw


def validate_outputs(spec, build):
    outputs = {o.path: o for o in build.stage.outputs.all()}
    receipt = build.stage.receipt or {}
    expected = [{"path": p, "sha256": o.sha256} for p, o in sorted(outputs.items())]
    if (
        build.stage.state != "succeeded"
        or set(outputs) != set(OUTPUT_MEDIA)
        or receipt.get("outcome") != "succeeded"
        or receipt.get("exit_code") != 0
        or sorted(receipt.get("outputs", []), key=lambda o: o.get("path", "")) != expected
    ):
        raise ValidationFailed(
            "Handoff requires a successful complete verified compiler output set."
        )
    if sum(o.size for o in outputs.values()) > MAX_OUTPUT_BYTES:
        raise ValidationFailed("Compiler outputs exceed their registered size bound.")
    rights = spec["sources"][0]["files"][0]["rights"]
    raw = {}
    for path, output in outputs.items():
        if (
            str(output.source_revision_id) != spec["sources"][0]["source_revision_id"]
            or output.rights != rights
            or output.media_type != OUTPUT_MEDIA[path]
            or output.size <= 0
            or output.size > MAX_OUTPUT_BYTES
        ):
            raise ValidationFailed("Compiler output provenance is inconsistent.")
        raw[path] = output_bytes(output)
    try:
        report = CompileReport.model_validate_json(raw["compile.json"])
        expected_handoff = {
            "format_version": 1,
            "inputs": spec,
            "flashing": "not_performed",
            "device_operation": "not_observed",
            "hardware_compatibility": "not_evaluated",
            "physical_qualification": False,
        }
        if (
            report.tool_packages != TOOL_PACKAGES
            or report.input_sha256 != hashlib.sha256(canonical(spec)).hexdigest()
            # The fixed adapter emits canonical bytes. Reject duplicate keys,
            # coercible booleans and other ambiguous representations even when
            # their transport hashes and last-key-wins parsed value agree.
            or raw["handoff.json"] != canonical(expected_handoff)
            or {o.path for o in report.outputs} != set(OUTPUT_MEDIA) - {"compile.json"}
            or len({o.path for o in report.outputs}) != len(report.outputs)
        ):
            raise ValueError("Manifest differs from exact compiler evidence")
        for item in report.outputs:
            if item.sha256 != outputs[item.path].sha256 or item.size != outputs[item.path].size:
                raise ValueError("Output hash differs")
        # Bounded structural checks are acceptance hygiene, not compiler or hardware qualification.
        elf = raw["firmware.elf"]
        if (
            len(elf) < 52
            or elf[:7] != b"\x7fELF\x01\x01\x01"
            or int.from_bytes(elf[18:20], "little") != 83
        ):
            raise ValueError("Expected ELF32 little-endian AVR output")
        lines = raw["firmware.hex"].decode("ascii").splitlines()
        if not lines or lines[-1] != ":00000001FF":
            raise ValueError("Expected complete Intel HEX")
        for line in lines:
            record = bytes.fromhex(line[1:])
            if (
                not line.startswith(":")
                or len(record) < 5
                or len(record) != record[0] + 5
                or sum(record) % 256
            ):
                raise ValueError("Invalid Intel HEX record")
    except (ValidationError, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        raise ValidationFailed("Registered compiler report or handoff is invalid.") from None
    return report, outputs


@operation(
    "firmware_build.read",
    CompileRef,
    supports_idempotency=False,
    summary="Inspect exact registered compiler evidence and separate firmware handoff.",
)
def read(ctx, p):
    _, spec, build = scoped_build(ctx, p)
    report, outputs = validate_outputs(spec, build)
    return {
        "reference": p.model_dump(mode="json"),
        "inputs": spec,
        "recipe_id": build.recipe_id,
        "image": build.recipe["image"],
        "limits": build.recipe["limits"],
        "report": report.model_dump(mode="json"),
        "report_sha256": outputs["compile.json"].sha256,
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
    }


@operation(
    "firmware_build.options",
    FirmwareRef,
    supports_idempotency=False,
    summary="List authorized compiler builds and explicit installed support limitations.",
)
def options(ctx, p):
    _, _, spec = inputs(ctx.user, p)
    reason, available = None, None
    try:
        executable_inputs(ctx.user, p)
        approved = approved_recipe(recipe_id(spec))
        checked_recipe(spec, approved)
        available = approved.id
    except Unsupported as exc:
        reason = str(exc)
    builds = []
    for build in BuildAttempt.objects.filter(recipe_id=recipe_id(spec)).order_by("-created_at")[
        :101
    ]:
        scoped_build(ctx, CompileRef(**p.model_dump(), build_id=build.id))
        builds.append(
            {
                "build_id": str(build.id),
                "state": build.stage.state,
                "failure": build.stage.receipt.get("message") if build.stage.receipt else None,
            }
        )
    return {
        "available_recipe_id": available,
        "unavailable_reason": reason,
        "inputs": spec,
        "builds": builds[:100],
        "truncated": len(builds) > 100,
        "hardware_compatibility": "not_evaluated",
        "flashing": "not_performed",
        "device_operation": "not_observed",
        "physical_qualification": False,
    }
