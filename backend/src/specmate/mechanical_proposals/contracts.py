"""Declared inputs for parametric mechanical proposals.

Every numeric field is nullable: ``None`` is an explicit unknown that keeps the
dependent feature incomplete. Zero is only ever a deliberate declaration where the
field permits it. Coordinates and sizes are millimetres in the native board frame.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.contracts import FiniteNumber
from specmate.operations.scope import WorkspacePayload

Side = Literal["west", "east", "north", "south"]
Face = Literal["lid", "floor"]
LocalId = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]

Positive = Annotated[FiniteNumber, Field(gt=0, le=10000)]
NonNegative = Annotated[FiniteNumber, Field(ge=0, le=10000)]
Offset = Annotated[FiniteNumber, Field(ge=-10000, le=10000)]

GENERATOR = "parametric-planar-v1"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Shell(Strict):
    board_clearance_mm: NonNegative | None = None
    wall_mm: Positive | None = None
    corner_radius_mm: NonNegative | None = None
    interior_height_mm: Positive | None = None
    board_thickness_mm: Positive | None = None


class Boss(Strict):
    outer_diameter_mm: Positive | None = None
    pilot_diameter_mm: Positive | None = None
    height_mm: NonNegative | None = None
    lid_clearance_diameter_mm: Positive | None = None


class MountChoice(Strict):
    """Native NPTH pad identity. Candidate holes are not mounts until chosen here."""

    pad_id: UUID
    use: bool


class ConnectorOpening(Strict):
    """A deliberate opening for one native component; labels never identify it."""

    component_id: UUID
    side: Side
    lateral_offset_mm: Offset | None = None
    width_mm: Positive | None = None
    height_mm: Positive | None = None
    center_above_board_mm: Offset | None = None
    clearance_mm: NonNegative | None = None


class VentArray(Strict):
    local_id: LocalId
    face: Face
    slot_width_mm: Positive | None = None
    slot_length_mm: Positive | None = None
    pitch_x_mm: Positive | None = None
    pitch_y_mm: Positive | None = None
    edge_margin_mm: NonNegative | None = None
    keepout_margin_mm: NonNegative | None = None


class CableGuide(Strict):
    local_id: LocalId
    side: Side
    offset_along_wall_mm: Offset | None = None
    cable_diameter_mm: Positive | None = None
    clearance_mm: NonNegative | None = None
    post_width_mm: Positive | None = None
    post_depth_mm: Positive | None = None


class Parameters(Strict):
    shell: Shell = Field(default_factory=Shell)
    boss: Boss = Field(default_factory=Boss)
    mounts: list[MountChoice] = Field(default_factory=list, max_length=256)
    connectors: list[ConnectorOpening] = Field(default_factory=list, max_length=64)
    vents: list[VentArray] = Field(default_factory=list, max_length=16)
    cable_guides: list[CableGuide] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def unique_identities(self):
        for label, values in (
            ("mount pad", [str(m.pad_id) for m in self.mounts]),
            ("connector component", [str(c.component_id) for c in self.connectors]),
            ("vent", [v.local_id for v in self.vents]),
            ("cable guide", [g.local_id for g in self.cable_guides]),
        ):
            if len(set(values)) != len(values):
                raise ValueError(f"{label} identities must be unique")
        return self


class CreateProposal(Strict, WorkspacePayload):
    interpretation_id: UUID
    name: str = Field(min_length=1, max_length=200)
    parameters: Parameters = Field(default_factory=Parameters)


class UpdateProposal(Strict):
    draft_id: UUID
    name: str | None = Field(default=None, min_length=1, max_length=200)
    parameters: Parameters


class RetainProposal(Strict):
    draft_id: UUID


class DraftRef(Strict):
    draft_id: UUID


class RetainedRef(Strict):
    revision_id: UUID
    workspace_id: UUID | None = None


class ListProposals(Strict):
    workspace_id: UUID


class BoardInputs(Strict):
    workspace_id: UUID
    interpretation_id: UUID
