"""Explicit material ownership and terminal relationships for branched harnesses.

Content schema 0.2: each harness endpoint is an end stack (board, inline parts, connector,
shell), pinned from an end assembly revision or declared ad hoc, exactly like a cable end
(without a stock end: physical ends say which section end is where). An endpoint terminal
names a layer and one of its terminals. Schema 0.1 (one connector per endpoint, endpoint
terminals by contact) stays readable and is upgraded in memory by ``upgrade_content``.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, ValidationError, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.interfaces.contracts import ContactId, Text, unique
from specmate.interfaces.end_assembly_contracts import EndStack, StackTerminalId
from specmate.interfaces.wiring_contracts import CONNECTOR_LAYER, ElementPath, Endpoint
from specmate.inventory.contracts import Amount


class SegmentEnd(StrictModel):
    segment_id: LocalId
    end: Literal["a", "b"]


class PhysicalEnd(StrictModel):
    """A declared material end, never derived from electrical relationships."""

    local_id: LocalId
    label: Text | None = None
    segment_ends: list[SegmentEnd] = Field(min_length=1, max_length=256)
    endpoint_id: LocalId | None = None
    basis: Text
    review: Literal["unreviewed", "reviewed"] = "unreviewed"

    @model_validator(mode="after")
    def distinct(self):
        unique([(end.segment_id, end.end) for end in self.segment_ends])
        return self


class Section(StrictModel):
    """One planned stock piece, even when several segments describe it."""

    local_id: LocalId
    stock_revision_id: UUID
    planned_cut_length_mm: Amount | None = None
    cut_basis: Text | None = None
    physical_ends: list[PhysicalEnd] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def distinct_ends(self):
        unique([end.local_id for end in self.physical_ends])
        return self


class Pigtail(StrictModel):
    """Prepared screens at one material end, twisted together and landed once."""

    local_id: LocalId
    end: Literal["a", "b"]
    element_paths: list[ElementPath] = Field(min_length=1, max_length=128)
    label: Text | None = None
    basis: Text

    @model_validator(mode="after")
    def unique_members(self):
        unique(self.element_paths)
        return self


class Segment(StrictModel):
    local_id: LocalId
    section_id: LocalId
    label: Text | None = None
    # Null = the section's complete declared conductive construction; [] = none.
    element_paths: list[ElementPath] | None = Field(default=None, max_length=1024)
    pigtails: list[Pigtail] = Field(
        default_factory=list, max_length=128, exclude_if=lambda value: not value
    )

    @model_validator(mode="after")
    def unique_paths(self):
        unique([(p.end, p.local_id) for p in self.pigtails])
        if self.element_paths is not None:
            unique(self.element_paths)
        return self


class SegmentTerminal(SegmentEnd):
    kind: Literal["segment"] = "segment"
    element_path: ElementPath


class PigtailTerminal(SegmentEnd):
    kind: Literal["pigtail"] = "pigtail"
    pigtail_id: LocalId


class EndpointTerminalV01(StrictModel):
    """A schema 0.1 endpoint terminal: one contact of the endpoint's connector."""

    kind: Literal["endpoint"] = "endpoint"
    endpoint_id: LocalId
    contact_id: ContactId


class EndpointTerminal(StrictModel):
    """One terminal of one layer of an endpoint's stack (contact, pad, lead or shell)."""

    kind: Literal["endpoint"] = "endpoint"
    endpoint_id: LocalId
    layer_id: LocalId
    terminal_id: StackTerminalId


Terminal = Annotated[
    SegmentTerminal | PigtailTerminal | EndpointTerminal, Field(discriminator="kind")
]


def terminal_key(terminal):
    if isinstance(terminal, PigtailTerminal):
        return ("pigtail", terminal.segment_id, terminal.end, terminal.pigtail_id)
    if isinstance(terminal, SegmentTerminal):
        return ("segment", terminal.segment_id, terminal.end, terminal.element_path)
    return ("endpoint", terminal.endpoint_id, terminal.layer_id, terminal.terminal_id)


class HarnessEnd(StrictModel):
    """One harness endpoint: a pinned end assembly or an ad-hoc end stack."""

    local_id: LocalId
    label: Text | None = None
    end_assembly_revision_id: UUID | None = None
    stack: EndStack | None = None

    @model_validator(mode="after")
    def one_source(self):
        if (self.end_assembly_revision_id is None) == (self.stack is None):
            raise ValueError("An endpoint pins an end assembly or declares a stack, not both.")
        return self


class Joint(StrictModel):
    local_id: LocalId
    kind: Literal["termination", "splice", "shield_bond", "solder"]
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
    schema_version: Literal["0.2"] = "0.2"
    sections: list[Section] = Field(default_factory=list, max_length=256)
    segments: list[Segment] = Field(default_factory=list, max_length=256)
    endpoints: list[HarnessEnd] = Field(default_factory=list, max_length=256)
    joints: list[Joint] = Field(default_factory=list, max_length=2000)
    breakouts: list[Breakout] = Field(default_factory=list, max_length=256)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 0.1 input (stored or submitted) is read through the 0.2 shape.
        if isinstance(value, dict) and value.get("schema_version", "0.1") == "0.1":
            try:
                return upgrade_content(value)
            except (ValidationError, KeyError, TypeError):
                raise ValueError("Invalid schema 0.1 harness content.") from None
        return value

    @model_validator(mode="after")
    def distinct(self):
        for rows in (self.sections, self.segments, self.endpoints, self.joints, self.breakouts):
            unique([row.local_id for row in rows])
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Review requires a declaration basis.")
        return self


def upgrade_content(value: dict) -> dict:
    """Map schema 0.1 harness content to 0.2; 0.2 content is returned unchanged.

    Each 0.1 endpoint becomes a one-layer connector stack named ``connector`` and each
    endpoint terminal names that layer's contact. Sections, segments, breakouts and joint
    kinds are unchanged.
    """
    if value.get("schema_version", "0.1") != "0.1":
        return value
    endpoints = [
        Endpoint.model_validate(e).model_dump(mode="json") for e in value.get("endpoints", [])
    ]

    def member(m):
        if isinstance(m, dict) and m.get("kind") == "endpoint":
            old = EndpointTerminalV01.model_validate(m)
            return {
                "kind": "endpoint",
                "endpoint_id": old.endpoint_id,
                "layer_id": CONNECTOR_LAYER,
                "terminal_id": old.contact_id,
            }
        return m

    return {
        **value,
        "schema_version": "0.2",
        "endpoints": [
            {
                "local_id": e["local_id"],
                "label": e["label"],
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
            for e in endpoints
        ],
        "joints": [
            {**j, "members": [member(m) for m in j.get("members", [])]}
            if isinstance(j, dict)
            else j
            for j in value.get("joints", [])
        ],
    }


class CreateHarness(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
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
