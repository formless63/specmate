"""Reviewed catalog lifecycle and explicit replacement, without rewriting consumers."""

from typing import Literal
from uuid import UUID

from django.db.models import OuterRef, Subquery, Value
from django.db.models.functions import Coalesce
from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.access.models import Workspace
from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import DefinitionLifecycle
from specmate.design.models import Definition
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.scope import workspace_scope
from specmate.queries import get_revision


class SetLifecycle(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    definition_id: UUID
    status: Literal["active", "development", "legacy", "retired", "superseded"]
    replacement_revision_id: UUID | None = None
    basis: str = Field(min_length=1, max_length=4000)

    @model_validator(mode="after")
    def replacement_required(self):
        if (self.status == "superseded") != (self.replacement_revision_id is not None):
            raise ValueError("Only superseded items require an exact replacement revision.")
        return self


class ReadLifecycle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    definition_id: UUID


@operation(
    "catalog.lifecycle",
    ReadLifecycle,
    summary="Inspect catalog lifecycle, retaining the selected exact revision.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def inspect_lifecycle(ctx: Context, p: ReadLifecycle):
    return result(definition_for(ctx.user, p.definition_id))


def definition_for(user, definition_id, permission=Perm.WORKSPACE_READ):
    definition = Definition.objects.filter(id=definition_id).first()
    if definition is None:
        raise NotFound("Definition not found.")
    authorize(user, definition.workspace_id, permission)
    return definition


def current(definition):
    return definition.lifecycle_events.select_related("replacement").order_by("-sequence").first()


def result(definition, event=None):
    event = current(definition) if event is None else event
    return {
        "definition_id": str(definition.id),
        "state": f"lifecycle-v{event.sequence if event else 0}",
        "status": event.status if event else "active",
        "replacement_revision_id": str(event.replacement_id)
        if event and event.replacement_id
        else None,
        "basis": event.basis if event else None,
    }


def annotate_status(query, *, definition_field="pk"):
    latest = DefinitionLifecycle.objects.filter(definition_id=OuterRef(definition_field)).order_by(
        "-sequence"
    )
    return query.annotate(
        catalog_status=Coalesce(Subquery(latest.values("status")[:1]), Value("active"))
    )


def current_definitions(query):
    """Superseded identities remain readable by exact link, but are not new choices."""
    return annotate_status(query).exclude(catalog_status="superseded")


def scope(ctx, p):
    definition = definition_for(ctx.user, p.definition_id)
    if p.replacement_revision_id:
        replacement = get_revision(ctx.user, p.replacement_revision_id)
        if replacement.definition.workspace_id != definition.workspace_id:
            raise NotFound("Not found.")
    return workspace_scope(ctx, definition.workspace_id)


def replay(ctx, p, stored):
    definition_for(ctx.user, p.definition_id, Perm.DESIGN_EDIT)
    if p.replacement_revision_id:
        get_revision(ctx.user, p.replacement_revision_id)


@operation(
    "catalog.set_lifecycle",
    SetLifecycle,
    summary="Record catalog status or replacement, preserving history and consumer pins.",
    requires_expected_state=True,
    idempotency_scope=scope,
    authorize_replay=replay,
    access=Perm.DESIGN_EDIT,
)
def set_lifecycle(ctx: Context, p: SetLifecycle):
    definition = definition_for(ctx.user, p.definition_id, Perm.DESIGN_EDIT)
    # Serialize replacement chains in a workspace, including opposite concurrent edges.
    Workspace.objects.select_for_update().get(pk=definition.workspace_id)
    prior = current(definition)
    if ctx.require_expected_state() != result(definition, prior)["state"]:
        raise Conflict("Catalog lifecycle changed.", details={"current": result(definition, prior)})
    if p.replacement_revision_id:
        target = get_revision(ctx.user, p.replacement_revision_id)
        if target.definition.workspace_id != definition.workspace_id:
            raise NotFound("Not found.")
        seen = {definition.id}
        while True:
            if target.definition_id in seen:
                raise ValidationFailed("Catalog replacement would create a cycle.")
            seen.add(target.definition_id)
            if len(seen) > 256:
                raise ValidationFailed("Catalog replacement chain exceeds the supported limit.")
            next_event = current(target.definition)
            if next_event is None or next_event.status != "superseded":
                break
            target = next_event.replacement
    event = DefinitionLifecycle.objects.create(
        definition=definition,
        sequence=prior.sequence + 1 if prior else 1,
        status=p.status,
        replacement_id=p.replacement_revision_id,
        basis=p.basis,
        registered_by=ctx.user,
    )
    return result(definition, event)
