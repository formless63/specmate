from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import UUID

from django.db.models import Max
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from specmate.access.permissions import Perm, authorize, authorize_item
from specmate.design.models import Definition, Draft, Revision, Snapshot, SnapshotDependency
from specmate.design.pins import NOT_FOUND, pin_workspace
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation

KIND_PATTERN = r"^[a-z][a-z0-9_]{0,49}$"


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def scoped_draft(ctx: Context, draft_id: UUID, perm: Perm, *, lock: bool = False) -> Draft:
    query = Draft.objects.select_related("definition")
    if lock:
        query = query.select_for_update(of=("self",))
    draft = query.filter(id=draft_id).first()
    if draft is None:
        raise NotFound("Draft not found.")
    # NotFound for non-members; contributors may edit drafts of definitions they created.
    authorize_item(ctx.user, draft.definition, perm)
    authorize_design_content(ctx.user, draft.definition, draft.content)
    return draft


def draft_state(draft: Draft) -> dict:
    return {
        "draft_id": str(draft.id),
        "state": draft.state_token,
        "content": draft.content,
        "base_revision_id": str(draft.base_revision_id) if draft.base_revision_id else None,
    }


def check_state(ctx: Context, draft: Draft) -> None:
    if ctx.require_expected_state() != draft.state_token:
        raise Conflict(
            "Draft changed since expected state.",
            details={"expected": ctx.expected_state, "current": draft_state(draft)},
        )


class CreateDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workspace_id: UUID
    kind: str = Field(pattern=KIND_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    content: dict[str, JsonValue] = Field(default_factory=dict)


@operation(
    "definition.create",
    CreateDefinition,
    summary="Create a reusable definition with an initial editable draft.",
    access=Perm.ITEM_CREATE,
)
def create_definition(ctx: Context, p: CreateDefinition) -> dict:
    workspace = authorize(ctx.user, p.workspace_id, Perm.ITEM_CREATE)
    definition = Definition.objects.create(
        workspace=workspace, kind=p.kind, name=p.name, created_by=ctx.user
    )
    content = validate_content(definition.kind, p.content)
    authorize_design_content(ctx.user, definition, content)
    draft = Draft.objects.create(definition=definition, content=content, updated_by=ctx.user)
    return {
        "definition_id": str(definition.id),
        "workspace_id": str(workspace.id),
        **draft_state(draft),
    }


class UpdateDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_id: UUID
    changes: dict[str, JsonValue] = Field(default_factory=dict)
    remove: list[str] = Field(default_factory=list)


@operation(
    "draft.update",
    UpdateDraft,
    summary="Set or remove top-level draft fields, rejecting stale expected state.",
    requires_expected_state=True,
    access=Perm.DESIGN_EDIT,
)
def update_draft(ctx: Context, p: UpdateDraft) -> dict:
    overlap = set(p.changes) & set(p.remove)
    if overlap:
        raise ValidationFailed("A field cannot be both changed and removed.")
    draft = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    check_state(ctx, draft)
    content = {k: v for k, v in draft.content.items() if k not in p.remove}
    content.update(p.changes)
    content = validate_content(draft.definition.kind, content)
    authorize_design_content(ctx.user, draft.definition, content)
    draft.content = content
    draft.version += 1
    draft.updated_by = ctx.user
    draft.save(update_fields=["content", "version", "updated_by", "updated_at"])
    return draft_state(draft)


class CaptureDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_id: UUID
    dependencies: list[UUID] = Field(default_factory=list, max_length=2000)


def _capture(ctx: Context, p: CaptureDraft, perm: Perm) -> tuple[Draft, Snapshot]:
    draft = scoped_draft(ctx, p.draft_id, perm, lock=True)
    # Typed closures reject foreign-workspace pins before the database guard can.
    with pin_workspace(draft.definition.workspace_id):
        return _capture_scoped(ctx, p, draft)


def _capture_scoped(ctx: Context, p: CaptureDraft, draft: Draft) -> tuple[Draft, Snapshot]:
    check_state(ctx, draft)
    validate_content(draft.definition.kind, draft.content)
    if len(set(p.dependencies)) != len(p.dependencies):
        raise ValidationFailed("Duplicate dependency.")
    dependencies = p.dependencies
    derived = None
    if draft.definition.kind == "assembly" and "assembly" in draft.content:
        from specmate.assemblies.queries import dependency_revisions

        derived = dependency_revisions(ctx.user, draft.definition, draft.content)
    from specmate.interfaces.contracts import KINDS as INTERFACE_KINDS

    if draft.definition.kind in INTERFACE_KINDS:
        from specmate.interfaces.queries import dependency_revisions as interface_dependencies

        derived = interface_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "workshop_profile":
        from specmate.workshop_profiles.queries import dependency_revisions

        if "profile" not in draft.content:
            raise ValidationFailed("A typed workshop profile is required before capture.")
        derived = dependency_revisions(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "end_preparation_profile":
        from specmate.end_preparation.queries import (
            dependency_revisions as end_preparation_dependencies,
        )

        derived = end_preparation_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "mechanical_source":
        from specmate.mechanical_sources.operations import dependency_revisions, require_freezable

        require_freezable(ctx.user, draft.definition, draft.content)
        derived = dependency_revisions(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "firmware":
        from specmate.pcb.firmware import dependency_revisions, require_freezable

        require_freezable(ctx.user, draft.definition, draft.content)
        derived = dependency_revisions(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "material_plan":
        from specmate.material_accounting.queries import (
            dependency_revisions as material_dependencies,
        )

        derived = material_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "preparation_profile":
        from specmate.preparation.queries import dependency_revisions as preparation_dependencies

        derived = preparation_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "bom_plan":
        from specmate.bom.queries import dependency_revisions as bom_dependencies

        derived = bom_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "cable_test_plan":
        from specmate.cable_test_intent.queries import (
            dependency_revisions as test_plan_dependencies,
        )

        derived = test_plan_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "cable":
        from specmate.cables.queries import dependency_revisions as cable_dependencies

        derived = cable_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "pcb_population":
        from specmate.pcb.population import dependency_revisions as population_dependencies

        derived = population_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "harness":
        from specmate.harnesses.queries import dependency_revisions as harness_dependencies

        derived = harness_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind in {"pcb_assertion", "pcb_comparison"}:
        from specmate.pcb_disagreement.queries import dependency_revisions as review_dependencies

        derived = review_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind == "passage_model":
        from specmate.passive_passages.queries import dependency_revisions as passage_dependencies

        derived = passage_dependencies(ctx.user, draft.definition, draft.content)
    if draft.definition.kind in {"option_set", "configuration"}:
        from specmate.configurations.queries import (
            dependency_revisions as configuration_dependencies,
        )
        from specmate.configurations.queries import require_capturable

        require_capturable(ctx.user, draft.definition, draft.content)
        derived = configuration_dependencies(ctx.user, draft.definition, draft.content)
    if derived is not None:
        if dependencies and set(dependencies) != set(derived):
            raise ValidationFailed("Dependencies must match the exact typed content closure.")
        dependencies = derived
    from specmate.catalog_packs.authoring import origin_revisions

    dependencies = sorted(
        set(dependencies) | set(origin_revisions(ctx.user, draft.definition)), key=str
    )
    if len(dependencies) > 2000:
        raise ValidationFailed("Captured engineering and origin dependencies exceed the limit.")
    revisions = list(
        Revision.objects.select_related("definition", "snapshot").filter(id__in=dependencies)
    )
    found = {r.id: r for r in revisions}
    pins = []
    authorized_snapshots = set()
    for rid in sorted(dependencies, key=str):
        revision = found.get(rid)
        if revision is None or revision.definition.workspace_id != draft.definition.workspace_id:
            # Pins never cross workspaces; a foreign revision reads as missing.
            raise NotFound(NOT_FOUND)
        authorize_snapshot(ctx.user, revision.snapshot, _authorized=authorized_snapshots)
        if revision.definition_id == draft.definition_id and derived is None:
            raise ValidationFailed("A definition cannot depend on its own revision.")
        pins.append({"revision_id": str(rid), "sha256": revision.snapshot.sha256})
    definition = draft.definition
    body = canonical_bytes(
        {
            "schema_version": "0.1",
            "definition_id": str(definition.id),
            "kind": definition.kind,
            "content": draft.content,
            "dependencies": pins,
        }
    )
    snapshot = Snapshot.objects.create(
        definition=definition,
        draft=draft,
        draft_version=draft.version,
        canonical=body,
        sha256=hashlib.sha256(body).hexdigest(),
        created_by=ctx.user,
    )
    SnapshotDependency.objects.bulk_create(
        SnapshotDependency(snapshot=snapshot, revision_id=rid) for rid in dependencies
    )
    return draft, snapshot


@operation(
    "draft.snapshot",
    CaptureDraft,
    summary="Capture the exact current draft as an immutable snapshot (e.g. for a build).",
    requires_expected_state=True,
    access=Perm.DESIGN_EDIT,
)
def snapshot_draft(ctx: Context, p: CaptureDraft) -> dict:
    _, snapshot = _capture(ctx, p, Perm.DESIGN_EDIT)
    return {"snapshot_id": str(snapshot.id), "sha256": snapshot.sha256}


@operation(
    "draft.freeze",
    CaptureDraft,
    summary="Freeze the exact current draft and its dependency pins as a new revision.",
    requires_expected_state=True,
    access=Perm.DESIGN_FREEZE,
)
def freeze_draft(ctx: Context, p: CaptureDraft) -> dict:
    draft, snapshot = _capture(ctx, p, Perm.DESIGN_FREEZE)
    # Serialize revision numbering per definition.
    Definition.objects.select_for_update().filter(id=draft.definition_id).first()
    latest = Revision.objects.filter(definition=draft.definition).aggregate(n=Max("number"))["n"]
    revision = Revision.objects.create(
        definition=draft.definition,
        number=(latest or 0) + 1,
        snapshot=snapshot,
        frozen_by=ctx.user,
    )
    draft.base_revision = revision
    draft.version += 1
    draft.updated_by = ctx.user
    draft.save(update_fields=["base_revision", "version", "updated_by", "updated_at"])
    return {
        "revision_id": str(revision.id),
        "number": revision.number,
        "snapshot_id": str(snapshot.id),
        "sha256": snapshot.sha256,
        "draft": draft_state(draft),
    }


def validate_content(kind, content):
    if kind == "mechanical_source" or "mechanical_source" in content:
        from specmate.mechanical_sources.operations import validate_content as validate_mechanical

        content = validate_mechanical(kind, content)
    if kind == "firmware" or "firmware" in content:
        from specmate.pcb.firmware import validate_content as validate_firmware

        content = validate_firmware(kind, content)
    if kind == "end_preparation_profile" or "end_preparation_profile" in content:
        from specmate.end_preparation.queries import validate_content as validate_end_preparation

        content = validate_end_preparation(kind, content)
    if kind == "cable_test_plan" or "test_plan" in content:
        from specmate.cable_test_intent.queries import validate_content as validate_test_plan

        content = validate_test_plan(kind, content)
    if kind == "material_plan" or "material_plan" in content:
        from specmate.material_accounting.queries import validate_content as validate_material

        content = validate_material(kind, content)
    if kind == "preparation_profile" or "preparation_profile" in content:
        from specmate.preparation.queries import validate_content as validate_preparation

        content = validate_preparation(kind, content)
    if kind == "passage_model" or "passages" in content:
        from specmate.passive_passages.queries import validate_content as validate_passages

        content = validate_passages(kind, content)
    if kind in {"pcb_assertion", "pcb_comparison"} or {
        "pcb_assertion",
        "pcb_comparison",
    }.intersection(content):
        from specmate.pcb_disagreement.queries import validate_content as validate_source_review

        content = validate_source_review(kind, content)
    if "harness" in content:
        from specmate.harnesses.queries import validate_content as validate_harness

        content = validate_harness(kind, content)
    if kind in {"option_set", "configuration"} or {"option_set", "configuration"}.intersection(
        content
    ):
        from specmate.configurations.queries import validate_content as validate_configuration

        content = validate_configuration(kind, content)
    if kind == "pcb_population" or "pcb_population" in content:
        from specmate.pcb.population import validate_content as validate_population

        content = validate_population(kind, content)
    if "cable" in content:
        from specmate.cables.queries import validate_content as validate_cable

        content = validate_cable(kind, content)
    if "bom" in content:
        from specmate.bom.queries import validate_content as validate_bom

        content = validate_bom(kind, content)
    if "profile" in content and kind != "workshop_profile":
        raise ValidationFailed("Workshop profiles require a workshop_profile definition.")
    if "interface" in content:
        from specmate.interfaces.queries import validate_content as validate_interface_content

        content = validate_interface_content(kind, content)
    if kind == "wire_stock":
        from specmate.wire_stock.schemas import validate_stock_content

        return validate_stock_content(content)
    if kind == "workshop_profile":
        from specmate.workshop_profiles.schemas import validate_profile_content

        return validate_profile_content(content)
    if "assembly" in content:
        from specmate.assemblies.queries import parse_content

        assembly = parse_content(content, kind=kind)
        return {**content, "assembly": assembly.model_dump(mode="json")}
    return content


def authorize_design_content(user, definition, content):
    # Every typed pin named in this content must stay in the definition's workspace.
    with pin_workspace(definition.workspace_id):
        _authorize_design_content(user, definition, content)


def _authorize_design_content(user, definition, content):
    from specmate.catalog_packs.authoring import authorize_origin

    authorize_origin(user, definition)
    if definition.kind == "mechanical_source" or "mechanical_source" in content:
        from specmate.mechanical_sources.operations import authorize_content as authorize_mechanical

        authorize_mechanical(user, definition, content)
    if definition.kind == "firmware" or "firmware" in content:
        from specmate.pcb.firmware import authorize_content as authorize_firmware

        authorize_firmware(user, definition, content)
    if definition.kind == "end_preparation_profile" or "end_preparation_profile" in content:
        from specmate.end_preparation.queries import authorize_content as authorize_end_preparation

        authorize_end_preparation(user, definition, content)
    if definition.kind == "cable_test_plan" or "test_plan" in content:
        from specmate.cable_test_intent.queries import authorize_content as authorize_test_plan

        authorize_test_plan(user, definition, content)
    if definition.kind == "material_plan" or "material_plan" in content:
        from specmate.material_accounting.queries import authorize_content as authorize_material

        authorize_material(user, definition, content)
    if definition.kind == "preparation_profile" or "preparation_profile" in content:
        from specmate.preparation.queries import authorize_content as authorize_preparation

        authorize_preparation(user, definition, content)
    if definition.kind == "passage_model" or "passages" in content:
        from specmate.passive_passages.queries import authorize_content as authorize_passages

        authorize_passages(user, definition, content)
    if definition.kind in {"pcb_assertion", "pcb_comparison"} or {
        "pcb_assertion",
        "pcb_comparison",
    }.intersection(content):
        from specmate.pcb_disagreement.queries import dependency_revisions as review_dependencies

        review_dependencies(user, definition, content)
    if "harness" in content:
        from specmate.harnesses.queries import dependency_revisions as harness_dependencies

        harness_dependencies(user, definition, content)
    if definition.kind in {"option_set", "configuration"} or {
        "option_set",
        "configuration",
    }.intersection(content):
        from specmate.configurations.queries import authorize_content as authorize_configuration

        authorize_configuration(user, definition, content)
    if definition.kind == "pcb_population" or "pcb_population" in content:
        from specmate.pcb.population import authorize_content as authorize_population

        authorize_population(user, definition, content)
    if "cable" in content:
        from specmate.cables.queries import dependency_revisions as cable_dependencies

        cable_dependencies(user, definition, content)
    if "bom" in content:
        from specmate.bom.queries import dependency_revisions as bom_dependencies

        bom_dependencies(user, definition, content)
    if definition.kind == "workshop_profile":
        from specmate.workshop_profiles.queries import authorize_profile_content

        authorize_profile_content(user, definition, content)
    if "assembly" in content:
        from specmate.assemblies.queries import dependency_revisions

        dependency_revisions(user, definition, content)
    if "interface" in content:
        from specmate.interfaces.queries import dependency_revisions as interface_dependencies

        interface_dependencies(user, definition, content)


def authorize_snapshot(user, snapshot, *, _authorized=None):
    """Authorize a snapshot and its exact pinned closure, validating typed content.

    Membership is checked once for the root's workspace: database guards keep every
    pin inside one workspace, so the closure needs no per-dependency membership lookup.
    The private set belongs to one synchronous traversal for one actor, never to a
    request cache or retained object. Failed traversals publish no completed work.
    Typed content and retained origins remain checked for each new snapshot.
    """
    workspace_id = snapshot.definition.workspace_id
    authorize(user, workspace_id, Perm.WORKSPACE_READ)
    pending = [snapshot]
    visited = set() if _authorized is None else set(_authorized)
    while pending:
        current = pending.pop()
        if current.pk in visited:
            continue
        visited.add(current.pk)
        if current.definition.workspace_id != workspace_id:
            # Unreachable while the same-workspace pin guard holds; never disclose.
            raise NotFound("Not found.")
        body = json.loads(bytes(current.canonical))
        authorize_design_content(user, current.definition, body["content"])
        for dependency in current.dependencies.select_related(
            "revision__definition", "revision__snapshot__definition"
        ):
            pending.append(dependency.revision.snapshot)
    if _authorized is not None:
        _authorized.update(visited)
