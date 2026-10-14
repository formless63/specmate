"""Print profile, preparation and optional slicing commands over the shared layers.

Profiles and preparations are ordinary versioned definitions (draft, frozen revision,
exact dependency pins). Slicing is an optional native build stage through the shared
approved-recipe/runner layer. No command here submits to or operates a printer.
"""

from __future__ import annotations

import hashlib

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.builds.models import BuildAttempt
from specmate.builds.operations import RequestBuild, request_build
from specmate.builds.recipes import Recipe, approved_recipe
from specmate.builds.rights import derive_for_revision
from specmate.catalog.scope import creation_workspace
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Definition, Draft
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    create_definition,
    freeze_draft,
    scoped_draft,
    update_draft,
)
from specmate.operations import Context, NotFound, Unsupported, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import workspace_scope
from specmate.printing.contracts import (
    PREPARATION_KEY,
    PREPARATION_KIND,
    PROFILE_KEY,
    PROFILE_KIND,
    CreatePrintPreparation,
    CreatePrintProfile,
    DraftRef,
    OrcaSliceReport,
    PreparationRef,
    ReadRecord,
    RequestSlice,
    SliceRef,
    SliceReport,
    UpdatePrintPreparation,
    UpdatePrintProfile,
    VariantsOf,
)
from specmate.printing.pack import (
    MAX_OUTPUT_BYTES,
    ORCA_ADAPTER,
    REPORT_PATH,
    TOOLS,
    canonical,
    output_media,
    recipe_for,
    recipe_id,
)
from specmate.printing.queries import (
    STATUS,
    authorize_content,
    dependency_revisions,
    parse_preparation,
    preparation_closure,
    read_record,
    readable,
    record_base,
    slice_spec,
    snapshot_content,
)
from specmate.queries import get_revision
from specmate.sources import blobstore
from specmate.sources.authority import authorize_revision

KINDS = {
    PROFILE_KIND: ("print_profile", PROFILE_KEY, "Print profile"),
    PREPARATION_KIND: ("print_preparation", PREPARATION_KEY, "Print preparation"),
}


def _typed(kind, payload):
    key = KINDS[kind][1]
    return {key: getattr(payload, key).model_dump(mode="json")}


def _draft(ctx, draft_id, kind, permission, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != kind:
        raise NotFound(f"{KINDS[kind][2]} draft not found.")
    return draft


def _record(definition, draft):
    return {**record_base(definition, draft), "content": draft.content}


def _scope(kind):
    def resolve(ctx, p):
        if isinstance(p, CreatePrintProfile | CreatePrintPreparation):
            workspace = creation_workspace(ctx.user, p.workspace_id)
            scope = workspace_scope(ctx, workspace.id, Perm.ITEM_CREATE)
            authorize_content(ctx.user, Definition(workspace=workspace, kind=kind), _typed(kind, p))
            return scope
        permission = Perm.DESIGN_FREEZE if isinstance(p, DraftRef) else Perm.DESIGN_EDIT
        draft = _draft(ctx, p.draft_id, kind, permission)
        if not isinstance(p, DraftRef):
            authorize_content(ctx.user, draft.definition, _typed(kind, p))
        return workspace_scope(ctx, draft.definition.workspace_id, permission)

    return resolve


def _replay(kind):
    def check(ctx, p, stored):
        """Retained responses must pass current checks on their original references."""
        scope = _scope(kind)(ctx, p)
        if isinstance(p, DraftRef):
            revision = get_revision(current_actor(ctx.user), stored["revision_id"])
            if revision.definition.kind != kind or scope != (
                f"workspace:{revision.definition.workspace_id}"
            ):
                raise NotFound(f"{KINDS[kind][2]} revision not found.")
            authorize_content(ctx.user, revision.definition, snapshot_content(revision))
            return
        definition = Definition.objects.filter(id=stored["definition_id"], kind=kind).first()
        if definition is None or scope != f"workspace:{definition.workspace_id}":
            raise NotFound(f"{KINDS[kind][2]} not found.")
        authorize_content(ctx.user, definition, stored["content"])

    return check


def _create(ctx, p, kind):
    workspace = creation_workspace(ctx.user, p.workspace_id)
    result = create_definition(
        ctx,
        CreateDefinition(
            workspace_id=workspace.id, kind=kind, name=p.name, content=_typed(kind, p)
        ),
    )
    draft = Draft.objects.select_related("definition").get(id=result["draft_id"])
    return _record(draft.definition, draft)


def _update(ctx, p, kind):
    draft = _draft(ctx, p.draft_id, kind, Perm.DESIGN_EDIT, lock=True)
    update_draft(ctx, UpdateDraft(draft_id=draft.id, changes=_typed(kind, p)))
    draft.refresh_from_db()
    return _record(draft.definition, draft)


def _freeze(ctx, p, kind):
    draft = _draft(ctx, p.draft_id, kind, Perm.DESIGN_FREEZE, lock=True)
    dependencies = dependency_revisions(ctx.user, draft.definition, draft.content)
    return freeze_draft(ctx, CaptureDraft(draft_id=draft.id, dependencies=dependencies))


# Profiles -------------------------------------------------------------------------


@operation(
    "print_profile.create",
    CreatePrintProfile,
    summary="Create a versioned printer, process or material profile; unknowns stay unknown.",
    idempotency_scope=_scope(PROFILE_KIND),
    authorize_replay=_replay(PROFILE_KIND),
    access=Perm.ITEM_CREATE,
)
def create_profile(ctx: Context, p: CreatePrintProfile) -> dict:
    creation_workspace(ctx.user, p.workspace_id, Perm.ITEM_CREATE)
    return _create(ctx, p, PROFILE_KIND)


@operation(
    "print_profile.update",
    UpdatePrintProfile,
    summary="Replace print profile parameters on a draft with optimistic state checking.",
    requires_expected_state=True,
    idempotency_scope=_scope(PROFILE_KIND),
    authorize_replay=_replay(PROFILE_KIND),
    access=Perm.DESIGN_EDIT,
)
def update_profile(ctx: Context, p: UpdatePrintProfile) -> dict:
    _draft(ctx, p.draft_id, PROFILE_KIND, Perm.DESIGN_EDIT)
    return _update(ctx, p, PROFILE_KIND)


@operation(
    "print_profile.freeze",
    DraftRef,
    summary="Freeze exact print profile parameters and their provenance as a revision.",
    requires_expected_state=True,
    idempotency_scope=_scope(PROFILE_KIND),
    authorize_replay=_replay(PROFILE_KIND),
    access=Perm.DESIGN_FREEZE,
)
def freeze_profile(ctx: Context, p: DraftRef) -> dict:
    _draft(ctx, p.draft_id, PROFILE_KIND, Perm.DESIGN_FREEZE)
    return _freeze(ctx, p, PROFILE_KIND)


@operation(
    "print_profile.read",
    ReadRecord,
    summary="Read a print profile draft or frozen revision with every parameter's provenance.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_profile(ctx: Context, p: ReadRecord) -> dict:
    return read_record(ctx.user, PROFILE_KIND, p.draft_id, p.revision_id)


# Preparations (manufacturing variants) --------------------------------------------


@operation(
    "print_preparation.create",
    CreatePrintPreparation,
    summary="Create a print preparation: a manufacturing variant of one mechanical part that "
    "pins its exact model, profiles, orientation, supports and slicer tool.",
    idempotency_scope=_scope(PREPARATION_KIND),
    authorize_replay=_replay(PREPARATION_KIND),
    access=Perm.ITEM_CREATE,
)
def create_preparation(ctx: Context, p: CreatePrintPreparation) -> dict:
    creation_workspace(ctx.user, p.workspace_id, Perm.ITEM_CREATE)
    return _create(ctx, p, PREPARATION_KIND)


@operation(
    "print_preparation.update",
    UpdatePrintPreparation,
    summary="Replace a print preparation draft with optimistic state checking.",
    requires_expected_state=True,
    idempotency_scope=_scope(PREPARATION_KIND),
    authorize_replay=_replay(PREPARATION_KIND),
    access=Perm.DESIGN_EDIT,
)
def update_preparation(ctx: Context, p: UpdatePrintPreparation) -> dict:
    _draft(ctx, p.draft_id, PREPARATION_KIND, Perm.DESIGN_EDIT)
    return _update(ctx, p, PREPARATION_KIND)


@operation(
    "print_preparation.freeze",
    DraftRef,
    summary="Freeze a print preparation with exact part and profile revision pins.",
    requires_expected_state=True,
    idempotency_scope=_scope(PREPARATION_KIND),
    authorize_replay=_replay(PREPARATION_KIND),
    access=Perm.DESIGN_FREEZE,
)
def freeze_preparation(ctx: Context, p: DraftRef) -> dict:
    _draft(ctx, p.draft_id, PREPARATION_KIND, Perm.DESIGN_FREEZE)
    return _freeze(ctx, p, PREPARATION_KIND)


@operation(
    "print_preparation.read",
    ReadRecord,
    summary="Read a print preparation with its part identity, effective parameters and "
    "their provenance, and slicing readiness; nothing is called printable.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_preparation(ctx: Context, p: ReadRecord) -> dict:
    return read_record(ctx.user, PREPARATION_KIND, p.draft_id, p.revision_id)


@operation(
    "print_preparation.variants",
    VariantsOf,
    summary="List the print preparations (manufacturing variants) of one mechanical part.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def variants(ctx: Context, p: VariantsOf) -> dict:
    definition = Definition.objects.filter(
        id=p.mechanical_definition_id, kind="mechanical_source"
    ).first()
    if definition is None:
        raise NotFound("Mechanical part not found.")
    authorize(ctx.user, definition.workspace_id, Perm.WORKSPACE_READ)
    mechanical = set(str(r) for r in definition.revisions.values_list("id", flat=True))
    rows = []
    drafts = Draft.objects.select_related("definition").filter(
        definition__workspace_id=definition.workspace_id, definition__kind=PREPARATION_KIND
    )
    for draft in drafts.order_by("definition__created_at", "id")[:500]:
        preparation = parse_preparation(draft.content, PREPARATION_KIND)
        if preparation is None or str(preparation.part.mechanical_revision_id) not in mechanical:
            continue
        if not readable(ctx.user, draft.definition, draft.content):
            continue
        rows.append(
            {
                **record_base(draft.definition, draft),
                "variant_label": preparation.variant_label,
                "technology": preparation.technology,
                "mechanical_revision_id": str(preparation.part.mechanical_revision_id),
                "model_path": preparation.part.path,
                "profiles": preparation.profiles.model_dump(mode="json"),
            }
        )
    return {
        "mechanical_definition_id": str(definition.id),
        "name": definition.name,
        "variants": rows,
        **STATUS,
    }


# Optional slicing stage ------------------------------------------------------------


def frozen_preparation(ctx, revision_id, permission=Perm.WORKSPACE_READ):
    user = current_actor(ctx.user)
    revision = get_revision(user, revision_id)
    if revision.definition.kind != PREPARATION_KIND:
        raise NotFound("Print preparation revision not found.")
    authorize(ctx.user, revision.definition.workspace_id, permission)
    preparation = parse_preparation(snapshot_content(revision), PREPARATION_KIND)
    if preparation is None:
        raise NotFound("Print preparation revision not found.")
    closure = preparation_closure(user, revision.definition, preparation)
    return revision, preparation, closure


def checked_recipe(spec, rights, recipe):
    expected = Recipe.model_validate(recipe_for(spec, recipe.image, rights))
    if recipe.model_dump(mode="json") != expected.model_dump(mode="json"):
        raise Unsupported("Approved recipe differs from the exact slicer program or inputs.")


def slicing_inputs(ctx, revision_id, permission=Perm.WORKSPACE_READ):
    revision, preparation, closure = frozen_preparation(ctx, revision_id, permission)
    spec = slice_spec(revision, preparation, closure)
    return revision, closure, spec, derive_for_revision(closure["bundle"])


def scoped_build(ctx, revision_id, build_id, permission=Perm.WORKSPACE_READ):
    revision, closure, spec, rights = slicing_inputs(ctx, revision_id, permission)
    build = BuildAttempt.objects.select_related("stage").filter(id=build_id).first()
    if build is None:
        raise NotFound("Slice build unavailable.")
    authorize(ctx.user, build.workspace_id, permission)
    actor = current_actor(ctx.user)
    authorize_revision(actor, build.source_revision)
    for output in build.stage.outputs.select_related("source_revision__bundle"):
        authorize_revision(actor, output.source_revision)
    if (
        build.workspace_id != revision.definition.workspace_id
        or build.source_revision_id != closure["bundle"].id
        or build.recipe_id != recipe_id(spec)
    ):
        raise NotFound("Slice build unavailable for this exact preparation.")
    try:
        checked_recipe(spec, rights, Recipe.model_validate(build.recipe))
    except ValidationError:
        raise ValidationFailed("Stored slicer recipe is invalid.") from None
    return revision, spec, rights, build


def _retained(ctx, stored):
    scoped_build(ctx, stored["preparation_revision_id"], stored["build_id"], Perm.BUILD_EXECUTE)


def slice_scope(ctx, p):
    revision = get_revision(current_actor(ctx.user), p.preparation_revision_id)
    if revision.definition.kind != PREPARATION_KIND:
        raise NotFound("Print preparation revision not found.")
    namespace = workspace_scope(ctx, revision.definition.workspace_id, Perm.BUILD_EXECUTE)
    if ctx.idempotency_key is not None:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation="print_slice.request",
            key=ctx.idempotency_key,
            scope=namespace,
        ):
            _retained(ctx, record.result)
    return namespace


def slice_replay(ctx, p, stored):
    _retained(ctx, stored)
    _, _, spec, rights = slicing_inputs(ctx, p.preparation_revision_id, Perm.BUILD_EXECUTE)
    checked_recipe(spec, rights, approved_recipe(p.recipe_id))


@operation(
    "print_slice.request",
    RequestSlice,
    status="accepted_async",
    idempotency_scope=slice_scope,
    authorize_replay=slice_replay,
    summary="Slice an exact frozen print preparation with an approved isolated slicer recipe. "
    "Generation is not printability or qualification; nothing is sent to a printer.",
    access=Perm.BUILD_EXECUTE,
)
def request_slice(ctx: Context, p: RequestSlice) -> dict:
    revision, closure, spec, rights = slicing_inputs(
        ctx, p.preparation_revision_id, Perm.BUILD_EXECUTE
    )
    if p.recipe_id != recipe_id(spec):
        raise Unsupported("Recipe is not the exact slicer recipe for this preparation.")
    checked_recipe(spec, rights, approved_recipe(p.recipe_id))
    result = request_build(
        ctx,
        RequestBuild(
            workspace_id=revision.definition.workspace_id,
            source_revision_id=closure["bundle"].id,
            recipe_id=p.recipe_id,
        ),
    )
    return {"preparation_revision_id": str(revision.id), **result}


def output_bytes(output):
    with blobstore.open_blob(output.sha256) as stream:
        raw = stream.read(MAX_OUTPUT_BYTES + 1)
    if len(raw) != output.size or hashlib.sha256(raw).hexdigest() != output.sha256:
        raise ValidationFailed("Stored slice bytes differ from registered evidence.")
    return raw


def validate_outputs(spec, rights, build):
    """Accept only a complete registered output set matching the exact slicer report."""
    stage = build.stage
    media = output_media(spec["output_format"], spec["adapter"])
    outputs = {o.path: o for o in stage.outputs.all()}
    receipt = stage.receipt or {}
    expected = [{"path": p, "sha256": o.sha256} for p, o in sorted(outputs.items())]
    if (
        stage.state != "succeeded"
        or set(outputs) != set(media)
        or receipt.get("outcome") != "succeeded"
        or receipt.get("exit_code") != 0
        or sorted(receipt.get("outputs", []), key=lambda o: o.get("path", "")) != expected
    ):
        raise ValidationFailed("Review requires a successful complete registered slice output set.")
    if sum(o.size for o in outputs.values()) > MAX_OUTPUT_BYTES:
        raise ValidationFailed("Registered slice outputs exceed their size bound.")
    raw = {}
    for path, output in outputs.items():
        if (
            output.source_revision_id != build.source_revision_id
            or output.rights != rights
            or output.media_type != media[path]
            or not 0 < output.size <= MAX_OUTPUT_BYTES
        ):
            raise ValidationFailed("Slice output provenance is inconsistent.")
        raw[path] = output_bytes(output)
    if spec["adapter"] == ORCA_ADAPTER:
        return validate_orca_report(spec, raw, outputs, media), outputs
    try:
        report = SliceReport.model_validate_json(raw[REPORT_PATH])
        listed = {o.path: o for o in report.outputs}
        tool = spec["tool"]
        if (
            report.input_sha256 != hashlib.sha256(canonical(spec)).hexdigest()
            or report.tool != {k: tool[k] for k in ("name", "package", "package_version")}
            or report.model_sha256 != spec["part"]["sha256"]
            or set(listed) != set(media) - {REPORT_PATH}
            or len(listed) != len(report.outputs)
        ):
            raise ValueError("Report differs from the exact slicer input")
        for path, item in listed.items():
            if item.sha256 != outputs[path].sha256 or item.size != outputs[path].size:
                raise ValueError("Output hash differs")
        estimates = report.estimates
        if spec["mass_estimate"] != "density_declared" and (
            estimates.filament_mass_g.status != "unknown"
        ):
            raise ValueError("Mass estimate claimed without a declared material density")
        if spec["output_format"] == "gcode":
            head = raw["slice.gcode"][:4096]
            if b"generated by PrusaSlicer 2.5.0" not in head:
                raise ValueError("Unexpected G-code producer")
        else:
            if not raw["prepared.3mf"].startswith(b"PK\x03\x04"):
                raise ValueError("Expected a 3MF container")
            if any(
                e.status != "unknown"
                for e in (
                    estimates.print_time_s,
                    estimates.filament_length_mm,
                    estimates.filament_mass_g,
                )
            ):
                raise ValueError("A prepared 3MF carries no slicer estimates")
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
        raise ValidationFailed("Registered slicer report is invalid.") from None
    return report, outputs


def validate_orca_report(spec, raw, outputs, media):
    """The OrcaSlicer report must match the exact input, presets, tool and output hashes."""
    tool = spec["tool"]
    try:
        report = OrcaSliceReport.model_validate_json(raw[REPORT_PATH])
        listed = {o.path: o for o in report.outputs}
        applied = report.applied_settings
        if (
            report.input_sha256 != hashlib.sha256(canonical(spec)).hexdigest()
            or report.tool
            != {k: tool[k] for k in ("name", "package", "package_version", "release_sha256")}
            or report.model_sha256 != spec["part"]["sha256"]
            or set(listed) != set(media) - {REPORT_PATH}
            or len(listed) != len(report.outputs)
            or applied.get("printer_settings_id") != spec["presets"]["printer"]["name"]
            or applied.get("print_settings_id") != spec["presets"]["process"]["name"]
            or applied.get("filament_settings_id") != spec["presets"]["material"]["name"]
            or {r: set(v) for r, v in report.overrides.items()}
            != {r: set(v) for r, v in spec["overrides"].items()}
        ):
            raise ValueError("Report differs from the exact slicer input")
        for path, item in listed.items():
            if item.sha256 != outputs[path].sha256 or item.size != outputs[path].size:
                raise ValueError("Output hash differs")
        if b"; generated by OrcaSlicer 2.4.2 " not in raw["slice.gcode"][:4096]:
            raise ValueError("Unexpected G-code producer")
        if "sliced.3mf" in media and not raw["sliced.3mf"].startswith(b"PK\x03\x04"):
            raise ValueError("Expected a 3MF container")
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
        raise ValidationFailed("Registered slicer report is invalid.") from None
    return report


@operation(
    "print_slice.read",
    SliceRef,
    supports_idempotency=False,
    summary="Inspect exact registered slicer evidence: profiles, tool, image, outputs and "
    "estimates. Not printability, printer submission or physical qualification.",
    access=Perm.WORKSPACE_READ,
)
def read_slice(ctx: Context, p: SliceRef) -> dict:
    revision, spec, rights, build = scoped_build(ctx, p.preparation_revision_id, p.build_id)
    report, outputs = validate_outputs(spec, rights, build)
    return {
        "preparation_revision_id": str(revision.id),
        "build_id": str(build.id),
        "inputs": spec,
        "recipe_id": build.recipe_id,
        "image": build.recipe["image"],
        "limits": build.recipe["limits"],
        "report_sha256": outputs[REPORT_PATH].sha256,
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


@operation(
    "print_slice.options",
    PreparationRef,
    supports_idempotency=False,
    summary="Show the exact slicer recipe identity, availability and slice attempts of a "
    "frozen preparation; generating the recipe grants no execution.",
    access=Perm.WORKSPACE_READ,
)
def slice_options(ctx: Context, p: PreparationRef) -> dict:
    revision, preparation, closure = frozen_preparation(ctx, p.preparation_revision_id)
    reason, available, proposed, builds = None, None, None, []
    try:
        _, _, spec, rights = slicing_inputs(ctx, p.preparation_revision_id)
    except Unsupported as exc:
        return {
            "preparation_revision_id": str(revision.id),
            "recipe_id": None,
            "available_recipe_id": None,
            "unavailable_reason": str(exc),
            "proposed_recipe": None,
            "builds": [],
            "tool": TOOLS[preparation.slicer_tool],
            **STATUS,
        }
    rid = recipe_id(spec)
    proposed = {**recipe_for(spec, None, rights), "image": None}
    try:
        checked_recipe(spec, rights, approved_recipe(rid))
        available = rid
    except Unsupported as exc:
        reason = str(exc)
    for build in (
        BuildAttempt.objects.select_related("stage")
        .filter(recipe_id=rid, source_revision_id=closure["bundle"].id)
        .order_by("-created_at")[:100]
    ):
        scoped_build(ctx, p.preparation_revision_id, build.id)
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
        "preparation_revision_id": str(revision.id),
        "recipe_id": rid,
        "available_recipe_id": available,
        "unavailable_reason": reason,
        "proposed_recipe": proposed,
        "builds": builds,
        "tool": spec["tool"],
        **STATUS,
    }
