"""Typed content of an accepted mechanical proposal's design draft.

The pinned retained id, hash and physical_qualification false are immutable: the draft
holds only this record, and draft.update may not change it.
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError as PydanticValidationError

from specmate.operations import NotFound, ValidationFailed

KIND = "enclosure_proposal"
KEY = "proposal_adoption"
Sha = Field(pattern=r"^[0-9a-f]{64}$")


class Adoption(BaseModel):
    model_config = ConfigDict(extra="forbid")
    retained_proposal_id: UUID
    retained_sha256: str = Sha
    proposal_draft_id: UUID
    interpretation_id: UUID
    interpretation_sha256: str = Sha
    generator: str = Field(min_length=1, max_length=100)
    status: Literal["incomplete", "declared_inputs_complete"]
    physical_qualification: Literal[False]


def parse(kind, content):
    if kind == KIND and set(content) != {KEY}:
        raise ValidationFailed("An enclosure proposal definition holds only its adoption record.")
    if KEY not in content:
        return None
    if kind != KIND:
        raise ValidationFailed(
            "Proposal adoption content requires an enclosure_proposal definition."
        )
    try:
        return Adoption.model_validate(content[KEY])
    except PydanticValidationError as exc:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        raise ValidationFailed("Invalid proposal adoption.", details={"errors": errors}) from None


def validate_content(kind, content):
    adoption = parse(kind, content)
    return {KEY: adoption.model_dump(mode="json")} if adoption else content


def authorize_content(user, definition, content):
    """The pinned retained record must exist in this workspace, match its hash and be readable."""
    from specmate.mechanical_proposals.models import ProposalRevision
    from specmate.mechanical_proposals.operations import revision_record

    adoption = parse(definition.kind, content)
    if adoption is None:
        return
    revision = ProposalRevision.objects.filter(id=adoption.retained_proposal_id).first()
    if (
        revision is None
        or revision.workspace_id != definition.workspace_id
        or revision.sha256 != adoption.retained_sha256
        or revision.draft_id != adoption.proposal_draft_id
        or revision.interpretation_id != adoption.interpretation_id
    ):
        raise NotFound("Retained proposal not found.")
    revision_record(user, revision.id, definition.workspace_id)
