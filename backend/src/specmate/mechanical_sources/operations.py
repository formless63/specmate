"""Native sources stay inert; exact readable inputs are managed by shared operations."""

from __future__ import annotations

import json

from pydantic import ValidationError as PydanticValidationError

from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import Representation
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
from specmate.mechanical_sources.contracts import (
    KEY,
    KIND,
    CreateMechanicalSource,
    DraftRef,
    MechanicalSource,
    ReadMechanicalSource,
    UpdateMechanicalSource,
)
from specmate.mechanical_sources.uncertainty import assess
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.pcb.population import Population, scoped_interpretation
from specmate.pcb.report import Report
from specmate.queries import get_bundle_revision, get_revision

STATUS = {
    "native_execution": "none",
    "geometry_validation": "not_performed",
    "clearance": "not_evaluated",
    "fit": "not_evaluated",
    "manufacturability": "not_evaluated",
    "physical_qualification": False,
}


def parse_content(content, kind=None):
    if kind == KIND and set(content) - {KEY}:
        raise ValidationFailed("A mechanical source definition holds only typed source content.")
    if KEY not in content:
        return None
    if kind is not None and kind != KIND:
        raise ValidationFailed("Mechanical source content requires a mechanical_source definition.")
    try:
        return MechanicalSource.model_validate(content[KEY])
    except PydanticValidationError as exc:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        raise ValidationFailed(
            "Invalid mechanical source content.", details={"errors": errors}
        ) from None


def validate_content(kind, content):
    declaration = parse_content(content, kind)
    return _content(declaration) if declaration else content


def _content(declaration):
    return {KEY: declaration.model_dump(mode="json")}


def _resolve(user, declaration):
    """Authorize all source/target/model closure before any mismatch or label disclosure."""
    user = current_actor(user)
    sources = {
        s.local_id: get_bundle_revision(user, s.source_revision_id) for s in declaration.sources
    }
    targets = {t.local_id: get_revision(user, t.revision_id) for t in declaration.targets}
    models = {}
    for pin in declaration.models:
        revision = get_revision(user, pin.revision_id)
        representation = (
            Representation.objects.select_related(
                "source_file__revision__bundle", "source_file__blob"
            )
            .filter(id=pin.representation_id)
            .first()
        )
        if representation is None:
            raise NotFound("Model representation not found.")
        # Even a wrong pin must authorize the actual represented revision and source first.
        get_revision(user, representation.revision_id)
        get_bundle_revision(user, representation.source_file.revision_id)
        models[pin.local_id] = (revision, representation)
    boards = {}
    for pin in declaration.targets:
        if pin.board is not None:
            get_bundle_revision(user, pin.board.source_revision_id)
            interpretation = scoped_interpretation(
                user, targets[pin.local_id].definition.workspace_id, pin.board.interpretation_id
            )
            get_bundle_revision(user, interpretation.attempt.intake.source_revision_id)
            boards[pin.local_id] = interpretation
    return sources, targets, models, boards


def _validate_exact(declaration, resolved):
    sources, targets, models, boards = resolved
    for pin in declaration.sources:
        revision = sources[pin.local_id]
        if revision.manifest_sha256 != pin.source_manifest_sha256:
            raise ValidationFailed("A source pin does not match its exact manifest.")
        files = {f.path: f for f in revision.files.select_related("blob")}
        for entry in pin.files:
            file = files.get(entry.path)
            if file is None or file.blob.sha256 != entry.sha256 or file.rights != entry.rights:
                raise ValidationFailed("A file pin does not match its preserved hash and rights.")
    for pin in declaration.targets:
        revision = targets[pin.local_id]
        if revision.snapshot.sha256 != pin.snapshot_sha256:
            raise ValidationFailed("A target pin does not match its exact revision snapshot.")
        if pin.board is None:
            if revision.definition.kind == "pcb_population":
                raise ValidationFailed(
                    "PCB targets require exact board interpretation/source pins."
                )
            continue
        if revision.definition.kind != "pcb_population":
            raise ValidationFailed("Board pins require a frozen PCB population revision.")
        population = Population.model_validate(
            json.loads(bytes(revision.snapshot.canonical))["content"]["pcb_population"]
        )
        board = pin.board
        if (
            population.interpretation_id != board.interpretation_id
            or population.interpretation_sha256 != board.interpretation_sha256
            or population.source_revision_id != board.source_revision_id
            or population.source_manifest_sha256 != board.source_manifest_sha256
            or boards[pin.local_id].sha256 != board.interpretation_sha256
        ):
            raise ValidationFailed(
                "Board pins do not match the exact population interpretation/source."
            )
    for pin in declaration.models:
        revision, representation = models[pin.local_id]
        source = sources[pin.source_local_id]
        if (
            revision.snapshot.sha256 != pin.snapshot_sha256
            or representation.kind != "model"
            or representation.revision_id != pin.revision_id
            or representation.source_file.revision_id != source.id
            or representation.source_file.path != pin.path
        ):
            raise ValidationFailed(
                "Model representation does not match its exact revision/source pin."
            )
        metadata = representation.model_metadata or {}
        for field in ("units", "frame"):
            declared, retained = getattr(pin, field), metadata.get(field)
            if declared is not None and retained is not None and declared != retained:
                raise ValidationFailed("Model units/frame contradict the exact representation.")


def closure(user, definition, content):
    declaration = parse_content(content, definition.kind)
    if declaration is None:
        return []
    resolved = _resolve(user, declaration)
    _validate_exact(declaration, resolved)
    return sorted(
        {t.revision_id for t in declaration.targets} | {m.revision_id for m in declaration.models},
        key=str,
    )


def authorize_content(user, definition, content):
    closure(user, definition, content)


def dependency_revisions(user, definition, content):
    return closure(user, definition, content)


def finding(code, status, message, local_id=None):
    return {"code": code, "status": status, "message": message, "local_id": local_id}


def evaluate(user, definition, declaration):
    resolved = _resolve(user, declaration)
    _validate_exact(declaration, resolved)
    sources, targets, models, boards = resolved
    findings = []
    source_rows = []
    for pin in declaration.sources:
        source = sources[pin.local_id]
        source_rows.append(
            {
                **pin.model_dump(mode="json"),
                "name": source.bundle.name,
                "number": source.number,
                "role": source.bundle.role,
                "derived_from": str(source.bundle.derived_from_id)
                if source.bundle.derived_from_id
                else None,
                "ancestry": json.loads(bytes(source.manifest)).get("ancestry", []),
            }
        )
        for file in pin.files:
            findings.append(
                finding(
                    "source_semantics",
                    "not_evaluated",
                    f"{file.path}: declared {file.format}; "
                    "native parsing/execution is not performed.",
                    pin.local_id,
                )
            )
            if file.role == "unsupported" or file.format == "other":
                findings.append(
                    finding(
                        "unsupported_source",
                        "unknown",
                        "Unsupported content remains preserved and inert; semantics are unknown.",
                        pin.local_id,
                    )
                )
            if file.rights.lower() in {"unknown", "unresolved"}:
                findings.append(
                    finding(
                        "source_rights",
                        "unknown",
                        "Distribution rights remain unresolved.",
                        pin.local_id,
                    )
                )
    if not declaration.targets:
        findings.append(
            finding("target", "unknown", "No board/component/hardware revision is pinned.")
        )
    target_rows = []
    for pin in declaration.targets:
        revision = targets[pin.local_id]
        row = {
            **pin.model_dump(mode="json"),
            "name": revision.definition.name,
            "number": revision.number,
            "kind": revision.definition.kind,
            "component": None,
            "board_geometry": None,
        }
        if pin.role == "board" and pin.board is None:
            findings.append(
                finding(
                    "board_geometry",
                    "unknown",
                    "This exact revision has no accepted board geometry pins; "
                    "clearance and component envelopes are unknown.",
                    pin.local_id,
                )
            )
        if pin.board is not None:
            report = Report.model_validate_json(bytes(boards[pin.local_id].canonical))
            population = Population.model_validate(
                json.loads(bytes(revision.snapshot.canonical))["content"]["pcb_population"]
            )
            option = next(
                (o for o in population.options if o.local_id == pin.board.option_id), None
            )
            # Geometry is retained extracted input, never promoted into a fit conclusion.
            row["board_geometry"] = {
                "outline": report.model_dump(mode="json")["outline"],
                "cutouts": report.model_dump(mode="json")["cutouts"],
                "outline_exact": report.model_dump(mode="json")["outline_exact"],
                "cutouts_exact": report.model_dump(mode="json")["cutouts_exact"],
                "outline_tolerance_mm": report.outline_tolerance_mm,
                "mounting_holes": [h.model_dump(mode="json") for h in report.mounting_holes],
                "coverage": report.coverage.model_dump(mode="json"),
                "unsupported": report.unsupported,
                "coordinate_frame": report.coordinate_frame,
                "units": report.units,
                "extractor": {"adapter": report.adapter, "tool_version": report.tool_version},
            }
            if pin.board.option_id is None:
                findings.append(
                    finding(
                        "population_option",
                        "unknown",
                        "Population option is unknown.",
                        pin.local_id,
                    )
                )
            elif option is None:
                findings.append(
                    finding(
                        "population_option",
                        "invalid",
                        "Pinned population option is absent.",
                        pin.local_id,
                    )
                )
            if pin.role == "component" and pin.native_component_id is None:
                findings.append(
                    finding(
                        "native_component",
                        "unknown",
                        "Native component identity is unresolved.",
                        pin.local_id,
                    )
                )
            if not report.outline:
                findings.append(
                    finding(
                        "board_geometry",
                        "unknown",
                        "Board outline geometry is unavailable; clearance cannot be inferred.",
                        pin.local_id,
                    )
                )
            if pin.native_component_id is not None:
                component = next(
                    (c for c in report.components if c.id == pin.native_component_id), None
                )
                if component is None:
                    findings.append(
                        finding(
                            "native_component",
                            "invalid",
                            "Component is absent from the exact board interpretation.",
                            pin.local_id,
                        )
                    )
                else:
                    row["component"] = component.model_dump(mode="json")
                    decision = (
                        next(
                            (d.status for d in option.decisions if d.component_id == component.id),
                            None,
                        )
                        if option
                        else None
                    )
                    findings.append(
                        finding(
                            "component_population",
                            "invalid"
                            if decision == "omit"
                            else "valid"
                            if decision == "populate"
                            else "unknown",
                            "Component population: " + (decision or "unknown") + ".",
                            pin.local_id,
                        )
                    )
        target_rows.append(row)
    model_rows = []
    for pin in declaration.models:
        _, representation = models[pin.local_id]
        model_rows.append(
            {
                **pin.model_dump(mode="json"),
                "label": representation.label,
                "sha256": representation.source_file.blob.sha256,
                "rights": representation.source_file.rights,
                **(
                    {"representation_metadata": representation.model_metadata}
                    if representation.model_metadata
                    else {}
                ),
            }
        )
        findings.append(
            finding(
                "model_correspondence",
                "not_evaluated",
                "Target correspondence is a declaration; "
                "compatibility and feature mapping are not verified.",
                pin.local_id,
            )
        )
        if pin.units is None or pin.frame is None or pin.accuracy is None:
            findings.append(
                finding(
                    "model_metadata",
                    "unknown",
                    "Model units, frame or accuracy are unresolved.",
                    pin.local_id,
                )
            )
    if not declaration.models:
        findings.append(
            finding(
                "model_geometry",
                "unknown",
                "No model geometry is pinned; missing geometry supplies no clearance evidence.",
            )
        )
    counts = {
        s: sum(f["status"] == s for f in findings)
        for s in ("valid", "invalid", "unknown", "not_evaluated")
    }
    return {
        "uncertainty_assessment": assess(declaration),
        "sources": source_rows,
        "targets": target_rows,
        "models": model_rows,
        "findings": findings,
        "counts": counts,
        "readiness": "blocked"
        if counts["invalid"]
        else "declared_with_unknowns"
        if counts["unknown"]
        else "declared",
        "limitations": declaration.limitations,
        **STATUS,
    }


def mechanical_draft(ctx, draft_id, permission=Perm.WORKSPACE_READ, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != KIND:
        raise NotFound("Mechanical source draft not found.")
    closure(ctx.user, draft.definition, draft.content)
    return draft


def _scope_inputs(ctx, payload, permission):
    """Resolve owning authority without pin diagnostics until retained inputs are known."""
    from specmate.catalog_packs.authoring import authorize_origin

    user = current_actor(ctx.user)
    if isinstance(payload, CreateMechanicalSource):
        workspace = authorize(user, payload.workspace_id, permission)
        definition = Definition(workspace=workspace, kind=KIND)
        contents = []
    else:
        draft = Draft.objects.select_related("definition").filter(id=payload.draft_id).first()
        if draft is None or draft.definition.kind != KIND:
            raise NotFound("Mechanical source draft not found.")
        definition = draft.definition
        authorize(user, definition.workspace_id, permission)
        authorize_origin(user, definition)
        contents = [(definition, draft.content)]
    if hasattr(payload, KEY):
        contents.append((definition, _content(payload.mechanical_source)))
    return definition, contents


def _check_contents(user, contents):
    # Current, incoming and retained declarations form one authority boundary. Resolve
    # every closure before reporting any hash/rights mismatch in any declaration.
    resolved = []
    for definition, content in contents:
        declaration = parse_content(content, definition.kind)
        if declaration is not None:
            resolved.append((declaration, _resolve(user, declaration)))
    for declaration, inputs in resolved:
        _validate_exact(declaration, inputs)


def _scope_closure(ctx, payload, permission):
    definition, contents = _scope_inputs(ctx, payload, permission)
    _check_contents(ctx.user, contents)
    return f"workspace:{definition.workspace_id}"


def _replay(ctx, payload, stored, permission=Perm.DESIGN_EDIT):
    from specmate.catalog_packs.authoring import authorize_origin

    _, contents = _scope_inputs(ctx, payload, permission)
    draft_id = stored.get("draft_id") or stored.get("draft", {}).get("draft_id")
    draft = Draft.objects.select_related("definition").filter(id=draft_id).first()
    if draft is None or draft.definition.kind != KIND:
        raise NotFound("Mechanical source draft not found.")
    authorize(ctx.user, draft.definition.workspace_id, permission)
    authorize_origin(ctx.user, draft.definition)
    contents.append((draft.definition, draft.content))
    if "content" in stored:
        contents.append((draft.definition, stored["content"]))
    if "revision_id" in stored:
        revision = get_revision(ctx.user, stored["revision_id"])
        if revision.definition.kind != KIND:
            raise NotFound("Mechanical source revision not found.")
        contents.append(
            (revision.definition, json.loads(bytes(revision.snapshot.canonical))["content"])
        )
    _check_contents(ctx.user, contents)


def _scope(name, permission=Perm.DESIGN_EDIT):
    def resolve(ctx, payload):
        from specmate.operations.models import IdempotencyRecord

        definition, contents = _scope_inputs(ctx, payload, permission)
        scope = f"workspace:{definition.workspace_id}"
        prior = IdempotencyRecord.objects.select_for_update().filter(
            actor=ctx.user, operation=name, key=ctx.idempotency_key
        )
        retained = prior.filter(scope=scope).first()
        if retained:
            _replay(ctx, payload, retained.result, permission)
        else:
            _check_contents(ctx.user, contents)
        return scope

    return resolve


@operation(
    "mechanical_source.create",
    CreateMechanicalSource,
    summary="Create reusable mechanical source declarations with exact source/target/model pins.",
    idempotency_scope=_scope("mechanical_source.create", Perm.ITEM_CREATE),
    authorize_replay=lambda ctx, payload, stored: _replay(ctx, payload, stored, Perm.ITEM_CREATE),
    access=Perm.ITEM_CREATE,
)
def create(ctx: Context, payload: CreateMechanicalSource):
    _scope_closure(ctx, payload, Perm.ITEM_CREATE)
    return create_definition(
        ctx,
        CreateDefinition(
            workspace_id=payload.workspace_id,
            kind=KIND,
            name=payload.name,
            content=_content(payload.mechanical_source),
        ),
    )


@operation(
    "mechanical_source.update",
    UpdateMechanicalSource,
    summary="Update mechanical source declarations with draft compare-and-set.",
    requires_expected_state=True,
    idempotency_scope=_scope("mechanical_source.update"),
    authorize_replay=_replay,
    access=Perm.DESIGN_EDIT,
)
def update(ctx: Context, payload: UpdateMechanicalSource):
    draft = mechanical_draft(ctx, payload.draft_id, Perm.DESIGN_EDIT, lock=True)
    closure(ctx.user, draft.definition, _content(payload.mechanical_source))
    return update_draft(
        ctx, UpdateDraft(draft_id=payload.draft_id, changes=_content(payload.mechanical_source))
    )


def require_freezable(user, definition, content):
    declaration = parse_content(content, definition.kind)
    if declaration is None:
        raise ValidationFailed("Typed mechanical source declarations are required before capture.")
    evaluation = evaluate(user, definition, declaration)
    invalid = [f for f in evaluation["findings"] if f["status"] == "invalid"]
    if invalid:
        raise ValidationFailed(
            "Invalid mechanical input declarations block capture.", details={"findings": invalid}
        )
    return evaluation


@operation(
    "mechanical_source.freeze",
    DraftRef,
    summary="Freeze exact mechanical source declarations while retaining unresolved geometry.",
    requires_expected_state=True,
    idempotency_scope=_scope("mechanical_source.freeze", Perm.DESIGN_FREEZE),
    authorize_replay=lambda ctx, p, stored: _replay(ctx, p, stored, Perm.DESIGN_FREEZE),
    access=Perm.DESIGN_FREEZE,
)
def freeze(ctx: Context, payload: DraftRef):
    draft = mechanical_draft(ctx, payload.draft_id, Perm.DESIGN_FREEZE, lock=True)
    evaluation = require_freezable(ctx.user, draft.definition, draft.content)
    result = freeze_draft(
        ctx,
        CaptureDraft(
            draft_id=draft.id, dependencies=closure(ctx.user, draft.definition, draft.content)
        ),
    )
    return {**result, "readiness": evaluation["readiness"], **STATUS}


def read_result(user, definition, content, draft=None, revision=None):
    declaration = parse_content(content, definition.kind)
    if declaration is None:
        raise ValidationFailed("Mechanical source content is absent.")
    return {
        "definition_id": str(definition.id),
        "name": definition.name,
        "draft_id": str(draft.id) if draft else None,
        "state": draft.state_token if draft else None,
        "revision_id": str(revision.id) if revision else None,
        "revision_number": revision.number if revision else None,
        "snapshot_sha256": revision.snapshot.sha256 if revision else None,
        "content": _content(declaration),
        "evaluation": evaluate(user, definition, declaration),
    }


def read_revision(user, revision_id):
    revision = get_revision(current_actor(user), revision_id)
    if revision.definition.kind != KIND:
        raise NotFound("Mechanical source revision not found.")
    return read_result(
        user,
        revision.definition,
        json.loads(bytes(revision.snapshot.canonical))["content"],
        revision=revision,
    )


@operation(
    "mechanical_source.read",
    ReadMechanicalSource,
    summary="Read mechanical declarations and exact provenance under current authority.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read(ctx: Context, payload: ReadMechanicalSource):
    if payload.revision_id:
        return read_revision(ctx.user, payload.revision_id)
    draft = mechanical_draft(ctx, payload.draft_id)
    return read_result(ctx.user, draft.definition, draft.content, draft=draft)
