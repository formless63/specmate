"""Typed validation, exact pin closure and scoped reads for print records."""

from __future__ import annotations

import hashlib
import json

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Draft
from specmate.mechanical_sources.contracts import KIND as MECHANICAL_KIND
from specmate.mechanical_sources.contracts import MechanicalSource
from specmate.operations import NotFound, Unsupported, ValidationFailed
from specmate.printing.contracts import (
    PREPARATION_KEY,
    PROFILE_KEY,
    PROFILE_KIND,
    REGISTRY,
    ROLES,
    PrintPreparation,
    PrintProfile,
)
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.models import SourceBundleFile
from specmate.workshop_profiles.schemas import SourceFile

STATUS = {
    "printable": "not_evaluated",
    "printer_submission": "not_available",
    "physical_qualification": False,
}


def _errors(exc):
    return [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]


def _parse(model, key, kind, content, label):
    if kind == key and set(content) - {key}:
        raise ValidationFailed(f"A {label} definition holds only typed {label} content.")
    if key not in content:
        return None
    if kind is not None and kind != key:
        raise ValidationFailed(f"{label.capitalize()} content requires a {key} definition.")
    try:
        return model.model_validate(content[key])
    except ValidationError as exc:
        raise ValidationFailed(f"Invalid {label}.", details={"errors": _errors(exc)}) from None


def parse_profile(content, kind=None) -> PrintProfile | None:
    return _parse(PrintProfile, PROFILE_KEY, kind, content, "print profile")


def parse_preparation(content, kind=None) -> PrintPreparation | None:
    return _parse(PrintPreparation, PREPARATION_KEY, kind, content, "print preparation")


def validate_content(kind, content):
    """Shared design hook: typed print content is normalized; other keys are rejected."""
    profile = parse_profile(content, kind)
    if profile is not None:
        content = {**content, PROFILE_KEY: profile.model_dump(mode="json")}
    preparation = parse_preparation(content, kind)
    if preparation is not None:
        content = {**content, PREPARATION_KEY: preparation.model_dump(mode="json")}
    return content


def snapshot_content(revision):
    return json.loads(bytes(revision.snapshot.canonical))["content"]


def _profile_sources(user, definition, profile: PrintProfile):
    """Authorize every cited source file before reporting any digest/rights mismatch."""
    cited = []
    for suggestion in profile.parameters.values():
        if isinstance(suggestion.source, SourceFile):
            revision = get_bundle_revision(user, suggestion.source.bundle_revision_id)
            cited.append((suggestion.source, revision))
    for source, revision in cited:
        if revision.bundle.workspace_id != definition.workspace_id:
            raise NotFound("Profile source file not found.")
        file = (
            SourceBundleFile.objects.select_related("blob")
            .filter(revision=revision, path=source.path)
            .first()
        )
        if file is None:
            raise NotFound("Profile source file not found.")
        if file.blob.sha256 != source.sha256 or file.rights != source.rights:
            raise ValidationFailed(
                "Profile source digest or rights differ from registered evidence."
            )


def _pinned(user, definition, pin, kind, label):
    revision = get_revision(current_actor(user), pin.revision_id)
    if (
        revision.definition.kind != kind
        or revision.definition.workspace_id != definition.workspace_id
    ):
        raise ValidationFailed(f"The {label} must be an exact revision in this workspace.")
    if revision.snapshot.sha256 != pin.snapshot_sha256:
        raise ValidationFailed(f"The {label} pin does not match its exact snapshot.")
    return revision


def preparation_closure(user, definition, preparation: PrintPreparation) -> dict:
    """Resolve the exact part, model file and profile revisions after authorizing all."""
    user = current_actor(user)
    part = preparation.part
    mechanical = get_revision(user, part.mechanical_revision_id)
    # Authorize every pinned profile before any mismatch diagnostic is disclosed.
    for role in ROLES:
        get_revision(user, getattr(preparation.profiles, role).revision_id)
    if (
        mechanical.definition.kind != MECHANICAL_KIND
        or mechanical.definition.workspace_id != definition.workspace_id
    ):
        raise ValidationFailed("The part must be an exact mechanical source revision.")
    if mechanical.snapshot.sha256 != part.snapshot_sha256:
        raise ValidationFailed("The part pin does not match its exact mechanical snapshot.")
    declaration = MechanicalSource.model_validate(snapshot_content(mechanical)[MECHANICAL_KIND])
    source = next((s for s in declaration.sources if s.local_id == part.source_local_id), None)
    file = next((f for f in source.files if f.path == part.path), None) if source else None
    if file is None or file.role != "model":
        raise ValidationFailed("The part pin must name a pinned model file of that revision.")
    bundle = get_bundle_revision(user, source.source_revision_id)
    stored = (
        SourceBundleFile.objects.select_related("blob")
        .filter(revision=bundle, path=file.path)
        .first()
    )
    if stored is None or stored.blob.sha256 != file.sha256 or stored.rights != file.rights:
        raise ValidationFailed("The pinned model file differs from its preserved bytes or rights.")
    resolved = {}
    for role in ROLES:
        pin = getattr(preparation.profiles, role)
        revision = _pinned(user, definition, pin, PROFILE_KIND, f"{role} profile")
        profile = parse_profile(snapshot_content(revision), PROFILE_KIND)
        if profile is None or profile.role != role:
            raise ValidationFailed(f"The {role} slot must pin a {role} profile.")
        if profile.technology != preparation.technology:
            raise ValidationFailed(f"The {role} profile is for {profile.technology} printing.")
        resolved[role] = (revision, profile)
    return {
        "mechanical": mechanical,
        "declaration": declaration,
        "model_file": file,
        "bundle": bundle,
        "profiles": resolved,
    }


def authorize_content(user, definition, content):
    profile = parse_profile(content, definition.kind)
    if profile is not None:
        _profile_sources(current_actor(user), definition, profile)
    preparation = parse_preparation(content, definition.kind)
    if preparation is not None:
        preparation_closure(user, definition, preparation)


def dependency_revisions(user, definition, content):
    """Exact capture closure: a profile pins nothing; a preparation pins part and profiles."""
    if definition.kind == PROFILE_KIND:
        profile = parse_profile(content, definition.kind)
        if profile is None:
            raise ValidationFailed("A typed print profile is required before capture.")
        _profile_sources(current_actor(user), definition, profile)
        return []
    preparation = parse_preparation(content, definition.kind)
    if preparation is None:
        raise ValidationFailed("A typed print preparation is required before capture.")
    preparation_closure(user, definition, preparation)
    return sorted(
        {preparation.part.mechanical_revision_id}
        | {getattr(preparation.profiles, role).revision_id for role in ROLES},
        key=str,
    )


def parameter_table(technology, role, profile: PrintProfile | None, origin=None) -> list[dict]:
    """Every known parameter for this role, with unknowns listed as unknown."""
    rows = []
    for (tech, row_role, key), spec in REGISTRY.items():
        if tech != technology or row_role != role:
            continue
        suggestion = profile.parameters.get(key) if profile else None
        known = suggestion is not None and suggestion.basis != "unknown"
        rows.append(
            {
                "role": role,
                "key": key,
                "label": spec.label,
                "unit": spec.unit,
                "type": spec.type,
                "choices": list(spec.choices),
                "slicer_setting": spec.slicer_key,
                "orca_settings": list(spec.orca_keys),
                "required_for_slicing": spec.required_for_slicing,
                "status": "declared" if known else "unknown",
                "value": suggestion.value if known else None,
                "basis": suggestion.basis if suggestion else "unknown",
                "source": suggestion.source.model_dump(mode="json")
                if known and suggestion.source
                else None,
                "note": suggestion.note if suggestion else None,
                **(origin or {}),
            }
        )
    return rows


def record_base(definition, draft=None, revision=None) -> dict:
    return {
        "definition_id": str(definition.id),
        "workspace_id": str(definition.workspace_id),
        "name": definition.name,
        "draft_id": str(draft.id) if draft else None,
        "state": draft.state_token if draft else None,
        "base_revision_id": str(draft.base_revision_id)
        if draft and draft.base_revision_id
        else None,
        "revision_id": str(revision.id) if revision else None,
        "revision_number": revision.number if revision else None,
        "snapshot_sha256": revision.snapshot.sha256 if revision else None,
    }


def profile_result(user, definition, content, draft=None, revision=None) -> dict:
    profile = parse_profile(content, definition.kind)
    if profile is not None:
        _profile_sources(current_actor(user), definition, profile)
    return {
        **record_base(definition, draft, revision),
        "content": content,
        "parameters": parameter_table(profile.technology, profile.role, profile) if profile else [],
    }


def _profiles(closure) -> dict:
    return {r: p.model_dump(mode="json") for r, (_, p) in closure["profiles"].items()}


def orca_blockers(preparation: PrintPreparation, closure) -> list[str]:
    from specmate.printing.pack import ORCA_MESH_SUFFIXES, orca_configuration

    blockers = []
    if not preparation.part.path.lower().endswith(ORCA_MESH_SUFFIXES):
        blockers.append(
            "Only STL meshes are qualified OrcaSlicer inputs; OBJ, 3MF, STEP and native CAD "
            "import are unverified in this pack."
        )
    if preparation.model_units.basis == "unknown":
        blockers.append("Model units are unknown; declare them before slicing.")
    elif preparation.model_units.value != "mm":
        blockers.append("Only millimeter models are qualified; no scale conversion is applied.")
    if preparation.orientation.status == "unknown":
        blockers.append("Orientation is unknown; declare as-modeled or an explicit rotation.")
    elif preparation.orientation.status == "rotated":
        blockers.append(
            "OrcaSlicer 2.4.2 crashes when its command line rotates a model; supply a model "
            "already oriented for printing and declare it as modeled."
        )
    if preparation.supports.status == "unknown":
        blockers.append("The support strategy is unknown; declare none, auto or build-plate only.")
    *_, missing = orca_configuration(_profiles(closure), preparation.supports.model_dump())
    if missing:
        blockers.append(
            "OrcaSlicer slicing builds on a bundled vendor preset; name one for the "
            + ", ".join(missing)
            + " profile."
        )
    return blockers


def slicing_blockers(preparation: PrintPreparation, closure) -> list[str]:
    from specmate.printing.pack import MESH_SUFFIXES, slicer_configuration

    blockers = []
    if preparation.technology != "fdm":
        return [
            "Resin slicing has no qualified pack; the variant is recorded without layer output. "
            "Sliced resin files (.ctb, .goo) can be inspected with the UVtools pack."
        ]
    if preparation.slicer_tool != "prusaslicer-2.5.0":
        return orca_blockers(preparation, closure)
    if not preparation.part.path.lower().endswith(MESH_SUFFIXES):
        blockers.append(
            "Only STL, OBJ or 3MF meshes are qualified slicer inputs; STEP and native CAD "
            "import are unverified in this pack."
        )
    if preparation.model_units.basis == "unknown":
        blockers.append("Model units are unknown; declare them before slicing.")
    elif preparation.model_units.value != "mm":
        blockers.append("Only millimeter models are qualified; no scale conversion is applied.")
    if preparation.orientation.status == "unknown":
        blockers.append("Orientation is unknown; declare as-modeled or an explicit rotation.")
    if preparation.supports.status == "unknown":
        blockers.append("The support strategy is unknown; declare none, auto or build-plate only.")
    profiles = {r: p.model_dump(mode="json") for r, (_, p) in closure["profiles"].items()}
    _, _, _, missing = slicer_configuration(
        preparation.technology, profiles, preparation.supports.model_dump()
    )
    if missing:
        blockers.append("Required slicer parameters are unknown: " + ", ".join(missing) + ".")
    return blockers


def slice_spec(revision, preparation: PrintPreparation, closure) -> dict:
    """The exact canonical slicer input of a frozen preparation, or Unsupported."""
    from specmate.printing.contracts import ORCA_TOOL_ID
    from specmate.printing.native_script import ADAPTER
    from specmate.printing.pack import (
        ORCA_ADAPTER,
        ORCA_TOOL,
        TOOL,
        orca_configuration,
        slicer_configuration,
    )

    blockers = slicing_blockers(preparation, closure)
    if blockers:
        raise Unsupported(" ".join(blockers))
    profiles = _profiles(closure)
    mechanical, file = closure["mechanical"], closure["model_file"]
    rotation = preparation.orientation.rotation_deg
    common = {
        "preparation": {
            "definition_id": str(revision.definition_id),
            "revision_id": str(revision.id),
            "snapshot_sha256": revision.snapshot.sha256,
        },
        "part": {
            "mechanical_definition_id": str(mechanical.definition_id),
            "mechanical_revision_id": str(mechanical.id),
            "snapshot_sha256": mechanical.snapshot.sha256,
            "source_revision_id": str(closure["bundle"].id),
            "path": file.path,
            "sha256": file.sha256,
            "rights": file.rights,
            "units": "mm",
        },
        "profiles": {
            role: {"revision_id": str(rev.id), "snapshot_sha256": rev.snapshot.sha256}
            for role, (rev, _) in closure["profiles"].items()
        },
        "orientation": {
            "status": preparation.orientation.status,
            "rotation_deg": list(rotation) if rotation else None,
        },
        "supports": preparation.supports.status,
        "copies": preparation.copies,
        "output_format": preparation.output_format,
    }
    if preparation.slicer_tool == ORCA_TOOL_ID:
        presets, overrides, declared, preset_settings, not_sent, _ = orca_configuration(
            profiles, preparation.supports.model_dump()
        )
        return {
            "adapter": ORCA_ADAPTER,
            "tool": ORCA_TOOL,
            **common,
            "presets": presets,
            "overrides": overrides,
            "declared": declared,
            "preset_settings": preset_settings,
            "not_sent": not_sent,
        }
    config, declared, defaults, _ = slicer_configuration(
        preparation.technology, profiles, preparation.supports.model_dump()
    )
    density = closure["profiles"]["material"][1].parameters.get("filament_density_g_cm3")
    return {
        "adapter": ADAPTER,
        "tool": TOOL,
        **common,
        "config": config,
        "declared": declared,
        "tool_defaults": defaults,
        "mass_estimate": "density_declared"
        if density is not None and density.basis != "unknown"
        else "density_unknown",
    }


def preparation_result(user, definition, content, draft=None, revision=None) -> dict:
    preparation = parse_preparation(content, definition.kind)
    base = {**record_base(definition, draft, revision), "content": content, **STATUS}
    if preparation is None:
        return {**base, "part_identity": None, "parameters": [], "slicing": None}
    closure = preparation_closure(user, definition, preparation)
    mechanical = closure["mechanical"]
    parameters = []
    for role in ROLES:
        profile_revision, profile = closure["profiles"][role]
        parameters += parameter_table(
            preparation.technology,
            role,
            profile,
            {
                "profile_definition_id": str(profile_revision.definition_id),
                "profile_name": profile_revision.definition.name,
                "profile_revision_id": str(profile_revision.id),
                "profile_revision_number": profile_revision.number,
            },
        )
    slicing = {
        "tool_id": preparation.slicer_tool,
        "blockers": slicing_blockers(preparation, closure),
        "requires_frozen_revision": revision is None,
    }
    if revision is not None and not slicing["blockers"]:
        spec = slice_spec(revision, preparation, closure)
        config = spec.get("config", spec.get("overrides"))
        slicing.update(
            {
                "configuration": config,
                "declared_settings": spec["declared"],
                "tool_default_settings": spec.get("tool_defaults", []),
                "configuration_sha256": hashlib.sha256(
                    json.dumps(config, sort_keys=True).encode()
                ).hexdigest(),
            }
        )
        if "presets" in spec:
            slicing.update(
                {
                    "presets": spec["presets"],
                    "preset_settings": spec["preset_settings"],
                    "not_sent_settings": spec["not_sent"],
                }
            )
    return {
        **base,
        "part_identity": {
            "mechanical_definition_id": str(mechanical.definition_id),
            "name": mechanical.definition.name,
            "item_role": closure["declaration"].item_role,
            "revision_number": mechanical.number,
            "model": {
                "path": closure["model_file"].path,
                "sha256": closure["model_file"].sha256,
                "rights": closure["model_file"].rights,
                "format": closure["model_file"].format,
                "source_revision_id": str(closure["bundle"].id),
            },
        },
        "parameters": parameters,
        "slicing": slicing,
    }


def read_record(user, kind, draft_id=None, revision_id=None) -> dict:
    from specmate.design.operations import scoped_draft
    from specmate.operations import Context

    builder = profile_result if kind == PROFILE_KIND else preparation_result
    label = "Print profile" if kind == PROFILE_KIND else "Print preparation"
    if revision_id is not None:
        revision = get_revision(current_actor(user), revision_id)
        if revision.definition.kind != kind:
            raise NotFound(f"{label} revision not found.")
        return builder(user, revision.definition, snapshot_content(revision), revision=revision)
    draft = scoped_draft(
        Context(user=user, via="internal", request_id="print-read"), draft_id, Perm.WORKSPACE_READ
    )
    if draft.definition.kind != kind:
        raise NotFound(f"{label} draft not found.")
    return builder(user, draft.definition, draft.content, draft=draft)


def readable(user, definition, content) -> bool:
    """Current authority over every pin a listed record would disclose; denied rows are omitted."""
    from specmate.operations import PermissionDenied

    try:
        authorize_content(user, definition, content)
    except (NotFound, PermissionDenied):
        return False
    except ValidationFailed:
        return True  # an inconsistent draft stays listed; its read reports the problem
    return True


def list_records(user, kind, workspace_id=None, project_id=None) -> list[dict]:
    """Library records; a project context lists the records it references first."""
    from specmate.catalog.scope import library_scope, references_definition

    workspace, project = library_scope(user, workspace_id, project_id)
    drafts = Draft.objects.select_related("definition").filter(
        definition__workspace=workspace, definition__kind=kind
    )
    order = ["definition__created_at", "id"]
    if project is not None:
        drafts = drafts.annotate(in_project=references_definition(project, "definition_id"))
        order.insert(0, "-in_project")
    rows = []
    for draft in drafts.order_by(*order)[:500]:
        if not readable(user, draft.definition, draft.content):
            continue
        row = {**record_base(draft.definition, draft), "content": draft.content}
        if project is not None:
            row["in_project"] = bool(draft.in_project)
        rows.append(row)
    return rows


def list_revisions(user, definition_id, kind) -> list[dict]:
    from specmate.design.models import Definition, Revision

    definition = Definition.objects.filter(id=definition_id, kind=kind).first()
    if definition is None:
        raise NotFound("Definition not found.")
    authorize(user, definition.workspace_id, Perm.WORKSPACE_READ)
    return [
        {
            "revision_id": str(r.id),
            "number": r.number,
            "sha256": r.snapshot.sha256,
            "frozen_at": r.frozen_at.isoformat(),
        }
        for r in Revision.objects.select_related("snapshot")
        .filter(definition=definition)
        .order_by("number")
    ]
