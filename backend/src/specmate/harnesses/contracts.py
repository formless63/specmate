"""Explicit material ownership and terminal relationships for branched harnesses."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.cables.contracts import ElementPath, Endpoint
from specmate.interfaces.contracts import ContactId, Text, unique
from specmate.inventory.contracts import Amount


class Section(StrictModel):
    """One original retained stock piece, even when several segments describe it."""

    local_id: LocalId
    stock_revision_id: UUID
    planned_cut_length_mm: Amount | None = None
    cut_basis: Text | None = None


class Segment(StrictModel):
    local_id: LocalId
    section_id: LocalId
    label: Text | None = None
    # Null = the section's complete declared conductive construction; [] = none.
    element_paths: list[ElementPath] | None = Field(default=None, max_length=1024)

    @model_validator(mode="after")
    def unique_paths(self):
        if self.element_paths is not None:
            unique(self.element_paths)
        return self


class SegmentEnd(StrictModel):
    segment_id: LocalId
    end: Literal["a", "b"]


class SegmentTerminal(SegmentEnd):
    kind: Literal["segment"] = "segment"
    element_path: ElementPath


class EndpointTerminal(StrictModel):
    kind: Literal["endpoint"] = "endpoint"
    endpoint_id: LocalId
    contact_id: ContactId


Terminal = Annotated[SegmentTerminal | EndpointTerminal, Field(discriminator="kind")]


def terminal_key(terminal):
    if isinstance(terminal, SegmentTerminal):
        return ("segment", terminal.segment_id, terminal.end, terminal.element_path)
    return ("endpoint", terminal.endpoint_id, terminal.contact_id)


class Joint(StrictModel):
    local_id: LocalId
    kind: Literal["termination", "splice", "shield_bond"]
    members: list[Terminal] = Field(min_length=2, max_length=64)
    basis: Text

    @model_validator(mode="after")
    def distinct(self):
        unique([terminal_key(member) for member in self.members])
        return self


class Through(StrictModel):
    local_id: LocalId
    kind: Literal["through"] = "through"
    trunk: SegmentTerminal
    leg: SegmentTerminal
    basis: Text


class JointFate(StrictModel):
    local_id: LocalId
    kind: Literal["joint"] = "joint"
    terminal: SegmentTerminal
    joint_id: LocalId


class Unconnected(StrictModel):
    local_id: LocalId
    kind: Literal["unconnected"] = "unconnected"
    terminal: SegmentTerminal
    basis: Text


Fate = Annotated[Through | JointFate | Unconnected, Field(discriminator="kind")]


class Breakout(StrictModel):
    local_id: LocalId
    trunk: SegmentEnd
    legs: list[SegmentEnd] = Field(min_length=1, max_length=64)
    fates: list[Fate] = Field(default_factory=list, max_length=2048)

    @model_validator(mode="after")
    def distinct(self):
        unique([(end.segment_id, end.end) for end in [self.trunk, *self.legs]])
        unique([fate.local_id for fate in self.fates])
        return self


class Harness(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    sections: list[Section] = Field(default_factory=list, max_length=256)
    segments: list[Segment] = Field(default_factory=list, max_length=256)
    endpoints: list[Endpoint] = Field(default_factory=list, max_length=256)
    joints: list[Joint] = Field(default_factory=list, max_length=2000)
    breakouts: list[Breakout] = Field(default_factory=list, max_length=256)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def distinct(self):
        for rows in (self.sections, self.segments, self.endpoints, self.joints, self.breakouts):
            unique([row.local_id for row in rows])
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Review requires a declaration basis.")
        return self


class CreateHarness(StrictModel):
    project_id: UUID
    name: Text
    harness: Harness


class UpdateHarness(StrictModel):
    draft_id: UUID
    harness: Harness


class CaptureHarness(StrictModel):
    draft_id: UUID


class ReadHarness(StrictModel):
    revision_id: UUID
    quantity: int | None = Field(default=1, strict=True, ge=1, le=1000000)


class InspectRelationships(StrictModel):
    revision_id: UUID
    terminal: Terminal
