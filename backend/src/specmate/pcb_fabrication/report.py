"""Bounded envelope; fabrication data stays in the exact registered files."""

from typing import Literal

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.pcb_fabrication.pack import LAYERS, OUTPUT_MEDIA, REPORT_PATH


class Output(StrictModel):
    path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size: int = Field(gt=0, le=16 * 1024**2)


class Counts(StrictModel):
    violations: int = Field(ge=0, le=100000)
    unconnected_items: int = Field(ge=0, le=100000)
    schematic_parity: int = Field(ge=0, le=100000)


class Drills(StrictModel):
    pth: list[tuple[float, float, float]] = Field(max_length=10000)
    npth: list[tuple[float, float, float]] = Field(max_length=10000)


class Report(StrictModel):
    format_version: Literal[1]
    adapter: Literal["kicad-fabrication-v1"]
    tool_version: Literal["10.0.6"]
    native_format_version: Literal[20260206]
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_unchanged: Literal[True]
    layers: list[str] = Field(max_length=9)
    drill_format: Literal["excellon-mm-decimal-absolute-separated-through"]
    drills: Drills
    drc_counts: Counts
    outputs: list[Output] = Field(min_length=13, max_length=13)
    physical_qualification: Literal[False]
    manufacturing_approval: Literal[False]
    unsupported: list[str] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def exact_outputs(self):
        if self.layers != LAYERS or {o.path for o in self.outputs} != set(OUTPUT_MEDIA) - {
            REPORT_PATH
        }:
            raise ValueError("Exact declared layers and complete outputs required")
        return self
