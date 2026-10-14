"""Bounded envelopes; fabrication data stays in the exact registered files."""

from typing import Literal

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.pcb_fabrication.native_script import DIAGNOSTICS
from specmate.pcb_fabrication.pack import REPORT_PATH, layers_for, output_media

SHA = r"^[0-9a-f]{64}$"


class Output(StrictModel):
    path: str
    sha256: str = Field(pattern=SHA)
    size: int = Field(gt=0, le=64 * 1024**2)


class Counts(StrictModel):
    violations: int = Field(ge=0, le=1000000)
    unconnected_items: int = Field(ge=0, le=1000000)
    schematic_parity: int = Field(ge=0, le=1000000)


Hole = tuple[float, float, float, float, float]


class Drills(StrictModel):
    """[x, y, size_x, size_y, slot rotation degrees] in native board millimetres."""

    pth: list[Hole] = Field(max_length=200000)
    npth: list[Hole] = Field(max_length=200000)


class Companion(StrictModel):
    path: str = Field(min_length=1, max_length=1024)
    sha256: str = Field(pattern=SHA)


class Features(StrictModel):
    through_vias: int = Field(ge=0)
    slots: int = Field(ge=0)
    copper_zones: int = Field(ge=0)
    copper_zones_without_stored_copper: int = Field(ge=0)
    rule_areas: int = Field(ge=0)
    zones_refilled: Literal[False]
    production_graphics: int = Field(ge=0)
    unresolved_text_variables: int = Field(ge=0)
    outlines: int = Field(ge=1)
    cutouts: int = Field(ge=0)


class Report(StrictModel):
    format_version: Literal[2]
    adapter: Literal["kicad-fabrication-v2"]
    status: Literal["succeeded"]
    tool_version: Literal["10.0.6"]
    native_format_version: Literal[20260206]
    source_sha256: str = Field(pattern=SHA)
    source_unchanged: Literal[True]
    project: Companion | None
    custom_rules: Companion | None
    copper_layer_count: int
    layers: list[str] = Field(max_length=39)
    drill_format: Literal["excellon-mm-decimal-absolute-separated-through-g85-slots"]
    drills: Drills
    features: Features
    drc_counts: Counts
    outputs: list[Output] = Field(min_length=13, max_length=45)
    physical_qualification: Literal[False]
    manufacturing_approval: Literal[False]
    unsupported: list[str] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def exact_outputs(self):
        try:
            layers = layers_for(self.copper_layer_count)
        except ValueError as exc:
            raise ValueError(str(exc)) from None
        expected = set(output_media(self.copper_layer_count)) - {REPORT_PATH}
        if self.layers != layers or {o.path for o in self.outputs} != expected:
            raise ValueError("Exact declared layers and complete outputs required")
        if len(self.outputs) != len(expected):
            raise ValueError("Duplicate output entries")
        return self


class Native(StrictModel):
    exit_code: int | None
    stderr_class: Literal[
        "terminated_by_signal",
        "invalid_input",
        "out_of_memory",
        "board_load",
        "filesystem",
        "layer_argument",
        "arguments",
        "unknown",
    ]
    stderr_excerpt: str = Field(max_length=4000)


class FailureReport(StrictModel):
    format_version: Literal[2]
    adapter: Literal["kicad-fabrication-v2"]
    status: Literal["failed"]
    code: int
    check: str = Field(max_length=64)
    message: str = Field(max_length=500)
    detail: str = Field(max_length=500)
    native: Native | None
    manufacturing_approval: Literal[False]
    physical_qualification: Literal[False]

    @model_validator(mode="after")
    def known_code(self):
        if DIAGNOSTICS.get(self.code) != (self.check, self.message):
            raise ValueError("Failure code, check and message must match the exact program")
        return self
