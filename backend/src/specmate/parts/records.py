"""Selected state only: an unrelated draft cannot authorize or block an exact revision."""

import json

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.catalog_packs.authoring import authorize_origin
from specmate.design.models import Definition, Draft, Revision
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.parts.contracts import CatalogRecord, ReadRecord
from specmate.queries import get_draft, get_revision


def selected_record(user, definition_id, selection):
    user = current_actor(user)
    definition = Definition.objects.filter(id=definition_id).first()
    if definition is None:
        raise NotFound("Definition not found.")
    authorize(user, definition.workspace_id, Perm.WORKSPACE_READ)
    authorize_origin(user, definition)
    revision = None
    if selection.revision_number is not None:
        revision = Revision.objects.filter(
            definition=definition, number=selection.revision_number
        ).first()
        if revision is None:
            raise NotFound("The requested exact revision is unavailable.")
    elif not selection.working and selection.draft_id is None:
        revision = definition.revisions.order_by("-number").first()
    if revision is not None:
        revision = get_revision(user, revision.id)
        selected = {
            "kind": "revision",
            "revision_id": str(revision.id),
            "number": revision.number,
            "snapshot_id": str(revision.snapshot_id),
            "sha256": revision.snapshot.sha256,
        }
        if selection.include_content:
            selected["content"] = json.loads(bytes(revision.snapshot.canonical))["content"]
    else:
        drafts = Draft.objects.filter(definition=definition)
        if selection.draft_id:
            draft = drafts.filter(id=selection.draft_id).first()
        else:
            choices = list(drafts.order_by("-updated_at", "-id")[:2])
            if len(choices) > 1:
                raise ValidationFailed(
                    "Choose an explicit working draft.", details={"draft_choice_required": True}
                )
            draft = choices[0] if choices else None
        if draft is None:
            raise NotFound("The selected working draft is unavailable.")
        current = get_draft(user, draft.id)
        selected = {
            "kind": "draft",
            **{
                key: value
                for key, value in current.items()
                if key != "definition_id" and (key != "content" or selection.include_content)
            },
        }
    return CatalogRecord(
        definition_id=definition.id,
        workspace_id=definition.workspace_id,
        name=definition.name,
        kind=definition.kind,
        selected=selected,
    ).model_dump(mode="json", exclude_unset=True)


@operation(
    "catalog.read_record",
    ReadRecord,
    supports_idempotency=False,
    summary="Read one requested exact revision or selected working draft with current authority.",
    access=Perm.WORKSPACE_READ,
)
def read_record(ctx: Context, payload: ReadRecord):
    return selected_record(ctx.user, payload.definition_id, payload)
