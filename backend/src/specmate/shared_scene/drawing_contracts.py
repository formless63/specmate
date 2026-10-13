"""Bounded internal inspection requests; no native format or distribution authority."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

Coordinate = Annotated[FiniteFloat, Field(ge=-1e9, le=1e9)]
Axis = Literal["x", "y", "z"]


class Explosion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    axis: Axis = "x"
    spacing_mm: Annotated[FiniteFloat, Field(ge=0, le=1e9)] = 20


class Opening(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        min_length=1, max_length=64
    )
    axis: Axis = "z"
    angle_deg: Annotated[FiniteFloat, Field(ge=-360, le=360)] = 90
    pivot_local_mm: tuple[Coordinate, Coordinate, Coordinate] = (0, 0, 0)


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    axis: Axis = "z"
    offset_mm: Coordinate = 0
    keep: Literal["positive", "negative"] = "positive"


class DrawingOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    view: Literal["top", "front", "end", "isometric"] = "top"
    explosion: Explosion = Field(default_factory=Explosion)
    opening: Opening | None = None
    section: Section = Field(default_factory=Section)


class CreateDrawing(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: UUID
    snapshot_id: UUID
    renderer_version: Literal["scene-line-svg-v1"] = "scene-line-svg-v1"
    purpose: Literal["internal_inspection"] = "internal_inspection"
    options: DrawingOptions = Field(default_factory=DrawingOptions)


class ReadDrawing(BaseModel):
    model_config = ConfigDict(extra="forbid")
    drawing_id: UUID
    project_id: UUID | None = None


class ReadDrawingScene(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: UUID
    snapshot_id: UUID
