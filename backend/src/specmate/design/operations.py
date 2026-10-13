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
    draft = Draft.objects.create(definition=definition, content=p.content, updated_by=ctx.user)
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
    draft.content = content
    draft.version += 1
    draft.updated_by = ctx.user
    draft.save(update_fields=["content", "version", "updated_by", "updated_at"])
    return draft_state(draft)


class CaptureDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_id: UUID
    dependencies: list[UUID] = Field(default_factory=list, max_length=1000)


def _capture(ctx: Context, p: CaptureDraft, perm: Perm) -> tuple[Draft, Snapshot]:
    draft = scoped_draft(ctx, p.draft_id, perm, lock=True)
    check_state(ctx, draft)
    if len(set(p.dependencies)) != len(p.dependencies):
        raise ValidationFailed("Duplicate dependency.")
    revisions = list(
        Revision.objects.select_related("definition", "snapshot").filter(id__in=p.dependencies)
    )
    found = {r.id: r for r in revisions}
    pins = []
    for rid in sorted(p.dependencies, key=str):
        revision = found.get(rid)
        if revision is None:
            raise NotFound("Dependency revision not found.")
        authorize(ctx.user, revision.definition.project_id, Perm.PROJECT_READ)
        if revision.definition_id == draft.definition_id:
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
        SnapshotDependency(snapshot=snapshot, revision_id=rid) for rid in p.dependencies
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
