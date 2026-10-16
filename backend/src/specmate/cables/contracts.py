"""Exact cable selections and declared terminations; no implied electrical bonds.

Content schema 0.2: each end is a stack (board, inline parts, connector, shell) pinned
from an end assembly revision or declared ad hoc, records which stock end it uses, and
terminations target a layer terminal. Schema 0.1 (one connector per end, terminations to
contacts) stays readable for frozen revisions; ``upgrade_content`` maps it to 0.2.
"""

from typing import Literal
from uuid import UUID

from pydantic import Field, ValidationError, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.cables.lengths import LengthPlan
from specmate.harnesses.contracts import Harness
from specmate.interfaces.contracts import ContactId, Text, unique
from specmate.interfaces.end_assembly_contracts import EndStack, StackTerminalId
from specmate.interfaces.wiring_contracts import CONNECTOR_LAYER, ElementPath, Endpoint


class Termination(StrictModel):
    """A schema 0.1 termination: a conductive stock element to one connector contact."""

    endpoint_id: LocalId
    element_path: ElementPath
    contact_id: ContactId
    basis: Text


class CableV01(StrictModel):
    """Schema 0.1 cable content, read for frozen revisions and upgraded in memory."""

    schema_version: Literal["0.1"] = "0.1"
    stock_revision_id: UUID
    lengths: LengthPlan | None = None
    endpoints: list[Endpoint] = Field(min_length=2, max_length=2)
    assignments: list[Termination] = Field(default_factory=list, max_length=2048)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def consistent(self):
        unique([e.local_id for e in self.endpoints])
        unique([(a.endpoint_id, a.element_path) for a in self.assignments])
        unique([(a.endpoint_id, a.contact_id) for a in self.assignments])
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed cable assignments require a basis.")
        return self


class CableEnd(StrictModel):
    """One cable end: a pinned end assembly or an ad-hoc stack, and the stock end it uses."""

    local_id: LocalId
    label: Text | None = None
    # Which end of the stock this end is on; unknown until declared.
    stock_end: Literal["a", "b", "unknown"] = "unknown"
    end_assembly_revision_id: UUID | None = None
    stack: EndStack | None = None

    @model_validator(mode="after")
    def one_source(self):
        if (self.end_assembly_revision_id is None) == (self.stack is None):
            raise ValueError("A cable end pins an end assembly or declares a stack, not both.")
        return self


class StackTermination(StrictModel):
    """A conductive stock element landed on one terminal of one layer of an end's stack."""

    endpoint_id: LocalId
    element_path: ElementPath
    layer_id: LocalId
    terminal_id: StackTerminalId
    basis: Text


class Cable(StrictModel):
    schema_version: Literal["0.2"] = "0.2"
    stock_revision_id: UUID
    # The cable intent this cable is meant to satisfy; pinned, never a pass by itself.
    intent_revision_id: UUID | None = None
    lengths: LengthPlan | None = None
    endpoints: list[CableEnd] = Field(min_length=2, max_length=2)
    assignments: list[StackTermination] = Field(default_factory=list, max_length=2048)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 0.1 input (stored or submitted) is read through the 0.2 shape.
        if isinstance(value, dict) and value.get("schema_version", "0.1") == "0.1":
            try:
                return upgrade_content(value)
            except ValidationError:
                raise ValueError("Invalid schema 0.1 cable content.") from None
        return value

    @model_validator(mode="after")
    def consistent(self):
        unique([e.local_id for e in self.endpoints])
        known = [e.stock_end for e in self.endpoints if e.stock_end != "unknown"]
        if len(known) != len(set(known)):
            raise ValueError("Two cable ends cannot use the same stock end.")
        unique([(a.endpoint_id, a.element_path) for a in self.assignments])
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed cable assignments require a basis.")
        return self


def upgrade_content(value: dict) -> dict:
    """Map schema 0.1 cable content to 0.2; 0.2 content is returned unchanged.

    Each 0.1 end becomes a one-layer connector stack with an unknown stock end, and each
    termination targets that connector layer's contact. Nothing else changes.
    """
    if value.get("schema_version", "0.1") != "0.1":
        return value
    old = CableV01.model_validate(value).model_dump(mode="json")
    return {
        **old,
        "schema_version": "0.2",
        "endpoints": [
            {
                "local_id": e["local_id"],
                "label": e["label"],
                "stock_end": "unknown",
                "end_assembly_revision_id": None,
                "stack": {
                    "layers": [
                        {
                            "kind": "connector",
                            "layer_id": CONNECTOR_LAYER,
                            "body_revision_id": e["body_revision_id"],
                            "pinout_revision_id": e["pinout_revision_id"],
                        }
                    ],
                    "joins": [],
                },
            }
            for e in old["endpoints"]
        ],
        "assignments": [
            {
                "endpoint_id": a["endpoint_id"],
                "element_path": a["element_path"],
                "layer_id": CONNECTOR_LAYER,
                "terminal_id": a["contact_id"],
                "basis": a["basis"],
            }
            for a in old["assignments"]
        ],
    }


class SectionCable(Harness):
    """A cable product with an explicit physical section graph.

    Uses the same material ownership and joint semantics as a harness, without changing
    the item's cable classification. No one-stock/two-end projection is inferred.
    """

    schema_version: Literal["0.3"] = "0.3"
    intent_revision_id: UUID | None = None


CableContent = Cable | SectionCable


class CreateCable(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
    name: Text
    cable: CableContent
    # Navigation context: the project that will reference the new cable.
    project_id: UUID | None = None


class UpdateCable(StrictModel):
    draft_id: UUID
    cable: CableContent


class CaptureCable(StrictModel):
    draft_id: UUID


class ReadCable(StrictModel):
    revision_id: UUID
    quantity: int = Field(default=1, strict=True, ge=1, le=1000000)


class LengthImpact(StrictModel):
    before_revision_id: UUID
    after_revision_id: UUID


class CheckIntent(StrictModel):
    """Check a cable draft or frozen revision against a cable intent (its pinned one)."""

    cable_revision_id: UUID | None = None
    draft_id: UUID | None = None
    intent_revision_id: UUID | None = None

    @model_validator(mode="after")
    def one(self):
        if (self.cable_revision_id is None) == (self.draft_id is None):
            raise ValueError("Check either a cable revision or a cable draft.")
        return self


class EndChoice(StrictModel):
    """One end for a proposal: a pinned end assembly or an ad-hoc stack."""

    label: Text | None = None
    stock_end: Literal["a", "b", "unknown"] | None = None
    end_assembly_revision_id: UUID | None = None
    stack: EndStack | None = None

    @model_validator(mode="after")
    def one_source(self):
        if (self.end_assembly_revision_id is None) == (self.stack is None):
            raise ValueError("An end pins an end assembly or declares a stack, not both.")
        return self


class ProposeCable(StrictModel):
    """Propose wiring from an intent; for a draft, its stock and ends are the defaults."""

    intent_revision_id: UUID
    stock_revision_id: UUID | None = None
    from_end: EndChoice | None = None
    to_end: EndChoice | None = None
    draft_id: UUID | None = None
