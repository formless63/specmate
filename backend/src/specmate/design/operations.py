from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import UUID

from django.db.models import Max
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Definition, Draft, Revision, Snapshot, SnapshotDependency
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
    authorize(ctx.user, draft.definition.project_id, perm)  # NotFound for non-members
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
    project_id: UUID
    kind: str = Field(pattern=KIND_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    content: dict[str, JsonValue] = Field(default_factory=dict)


@operation(
    "definition.create",
    CreateDefinition,
    summary="Create a reusable definition with an initial editable draft.",
)
def create_definition(ctx: Context, p: CreateDefinition) -> dict:
    project = authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    definition = Definition.objects.create(
        project=project, kind=p.kind, name=p.name, created_by=ctx.user
    )
    content = validate_content(definition.kind, p.content)
    authorize_design_content(ctx.user, definition, content)
    draft = Draft.objects.create(definition=definition, content=content, updated_by=ctx.user)
    return {"definition_id": str(definition.id), **draft_state(draft)}


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
    for rid in sorted(dependencies, key=str):
        revision = found.get(rid)
        if revision is None:
            raise NotFound("Dependency revision not found.")
        authorize_snapshot(ctx.user, revision.snapshot)
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
)
def snapshot_draft(ctx: Context, p: CaptureDraft) -> dict:
    _, snapshot = _capture(ctx, p, Perm.DESIGN_EDIT)
    return {"snapshot_id": str(snapshot.id), "sha256": snapshot.sha256}


@operation(
    "draft.freeze",
    CaptureDraft,
    summary="Freeze the exact current draft and its dependency pins as a new revision.",
    requires_expected_state=True,
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
    if kind == "cable_test_plan" or "test_plan" in content:
        from specmate.cable_test_intent.queries import validate_content as validate_test_plan

        content = validate_test_plan(kind, content)
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
    from specmate.catalog_packs.authoring import authorize_origin

    authorize_origin(user, definition)
    if definition.kind == "cable_test_plan" or "test_plan" in content:
        from specmate.cable_test_intent.queries import authorize_content as authorize_test_plan

        authorize_test_plan(user, definition, content)
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


def authorize_snapshot(user, snapshot):
    """Authorize every exact dependency before any retained canonical state is exposed."""
    pending = [snapshot]
    visited = set()
    while pending:
        current = pending.pop()
        if current.pk in visited:
            continue
        visited.add(current.pk)
        authorize(user, current.definition.project_id, Perm.PROJECT_READ)
        body = json.loads(bytes(current.canonical))
        authorize_design_content(user, current.definition, body["content"])
        for dependency in current.dependencies.select_related(
            "revision__definition", "revision__snapshot__definition"
        ):
            pending.append(dependency.revision.snapshot)
