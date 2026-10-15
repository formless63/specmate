"""Print profiles and preparation records (PRT-001/PRT-002).

Profiles hold process/material/printer parameters as suggestions with provenance; an
absent or unknown parameter stays unknown and is never replaced by a slicer default in
the record. A preparation is a manufacturing variant of one mechanical part identity:
it pins an exact mechanical source revision and model file, exact profile revisions,
orientation, supports and the slicer tool. Nothing here operates a printer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

from specmate.contracts import SHA256, check_package_path
from specmate.workshop_profiles.schemas import Suggestion

PROFILE_KIND = "print_profile"
PROFILE_KEY = "print_profile"
PREPARATION_KIND = "print_preparation"
PREPARATION_KEY = "print_preparation"

Technology = Literal["fdm", "resin"]
Role = Literal["printer", "process", "material"]
ROLES: tuple[Role, ...] = ("printer", "process", "material")
ParameterKey = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


@dataclass(frozen=True)
class Parameter:
    """One known parameter. ``slicer_key`` None means descriptive only (never sent)."""

    technology: str
    role: str
    key: str
    label: str
    type: Literal["number", "integer", "choice"]
    unit: str | None = None
    minimum: float | None = None
    maximum: float | None = None
    choices: tuple[str, ...] = ()
    slicer_key: str | None = None
    required_for_slicing: bool = False
    # OrcaSlicer setting keys this parameter overrides on top of the named vendor preset.
    # Empty: the parameter is descriptive for OrcaSlicer and never sent (the preset governs).
    orca_keys: tuple[str, ...] = ()
    orca_vector: bool = False


def _p(technology, role, key, label, kind="number", **rest):
    return Parameter(technology, role, key, label, kind, **rest)


# OrcaSlicer bed temperatures are per plate type; a declared bed temperature sets them all.
BED_PLATES = ("hot_plate_temp", "textured_plate_temp", "cool_plate_temp", "eng_plate_temp")
FLAVORS = ("marlin2", "marlin", "reprap", "reprapfirmware", "repetier", "smoothie")
FDM_FAMILIES = ("PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "other")
RESIN_FAMILIES = ("standard", "tough", "flexible", "castable", "other")

PARAMETERS: tuple[Parameter, ...] = (
    # FDM printer
    _p(
        "fdm",
        "printer",
        "nozzle_diameter_mm",
        "Nozzle diameter",
        unit="mm",
        minimum=0.05,
        maximum=3,
        slicer_key="nozzle_diameter",
        required_for_slicing=True,
        orca_keys=("nozzle_diameter",),
        orca_vector=True,
    ),
    _p(
        "fdm",
        "printer",
        "bed_size_x_mm",
        "Bed size X",
        unit="mm",
        minimum=10,
        maximum=2000,
        slicer_key="bed_shape",
        required_for_slicing=True,
        orca_keys=("printable_area",),
    ),
    _p(
        "fdm",
        "printer",
        "bed_size_y_mm",
        "Bed size Y",
        unit="mm",
        minimum=10,
        maximum=2000,
        slicer_key="bed_shape",
        required_for_slicing=True,
        orca_keys=("printable_area",),
    ),
    _p(
        "fdm",
        "printer",
        "max_print_height_mm",
        "Maximum print height",
        unit="mm",
        minimum=1,
        maximum=2000,
        slicer_key="max_print_height",
        orca_keys=("printable_height",),
    ),
    _p(
        "fdm",
        "printer",
        "gcode_flavor",
        "G-code flavor",
        "choice",
        choices=FLAVORS,
        slicer_key="gcode_flavor",
    ),
    # FDM material
    _p("fdm", "material", "material_family", "Material family", "choice", choices=FDM_FAMILIES),
    _p(
        "fdm",
        "material",
        "filament_diameter_mm",
        "Filament diameter",
        unit="mm",
        minimum=0.5,
        maximum=5,
        slicer_key="filament_diameter",
        required_for_slicing=True,
        orca_keys=("filament_diameter",),
        orca_vector=True,
    ),
    _p(
        "fdm",
        "material",
        "nozzle_temperature_c",
        "Nozzle temperature",
        unit="°C",
        minimum=100,
        maximum=500,
        slicer_key="temperature",
        required_for_slicing=True,
        orca_keys=("nozzle_temperature",),
        orca_vector=True,
    ),
    _p(
        "fdm",
        "material",
        "first_layer_nozzle_temperature_c",
        "First layer nozzle temperature",
        unit="°C",
        minimum=100,
        maximum=500,
        slicer_key="first_layer_temperature",
        orca_keys=("nozzle_temperature_initial_layer",),
        orca_vector=True,
    ),
    _p(
        "fdm",
        "material",
        "bed_temperature_c",
        "Bed temperature",
        unit="°C",
        minimum=0,
        maximum=200,
        slicer_key="bed_temperature",
        orca_keys=BED_PLATES,
        orca_vector=True,
    ),
    _p(
        "fdm",
        "material",
        "first_layer_bed_temperature_c",
        "First layer bed temperature",
        unit="°C",
        minimum=0,
        maximum=200,
        slicer_key="first_layer_bed_temperature",
        orca_keys=tuple(k + "_initial_layer" for k in BED_PLATES),
        orca_vector=True,
    ),
    _p(
        "fdm",
        "material",
        "filament_density_g_cm3",
        "Filament density",
        unit="g/cm³",
        minimum=0.1,
        maximum=25,
        slicer_key="filament_density",
        orca_keys=("filament_density",),
        orca_vector=True,
    ),
    _p(
        "fdm",
        "material",
        "extrusion_multiplier",
        "Extrusion multiplier",
        minimum=0.5,
        maximum=2,
        slicer_key="extrusion_multiplier",
        orca_keys=("filament_flow_ratio",),
        orca_vector=True,
    ),
    # FDM process
    _p(
        "fdm",
        "process",
        "layer_height_mm",
        "Layer height",
        unit="mm",
        minimum=0.01,
        maximum=2,
        slicer_key="layer_height",
        required_for_slicing=True,
        orca_keys=("layer_height",),
    ),
    _p(
        "fdm",
        "process",
        "first_layer_height_mm",
        "First layer height",
        unit="mm",
        minimum=0.01,
        maximum=2,
        slicer_key="first_layer_height",
        orca_keys=("initial_layer_print_height",),
    ),
    _p(
        "fdm",
        "process",
        "perimeters",
        "Perimeters",
        "integer",
        minimum=0,
        maximum=50,
        slicer_key="perimeters",
        orca_keys=("wall_loops",),
    ),
    _p(
        "fdm",
        "process",
        "top_solid_layers",
        "Top solid layers",
        "integer",
        minimum=0,
        maximum=100,
        slicer_key="top_solid_layers",
        orca_keys=("top_shell_layers",),
    ),
    _p(
        "fdm",
        "process",
        "bottom_solid_layers",
        "Bottom solid layers",
        "integer",
        minimum=0,
        maximum=100,
        slicer_key="bottom_solid_layers",
        orca_keys=("bottom_shell_layers",),
    ),
    _p(
        "fdm",
        "process",
        "fill_density_percent",
        "Infill density",
        unit="%",
        minimum=0,
        maximum=100,
        slicer_key="fill_density",
        orca_keys=("sparse_infill_density",),
    ),
    _p(
        "fdm",
        "process",
        "brim_width_mm",
        "Brim width",
        unit="mm",
        minimum=0,
        maximum=100,
        slicer_key="brim_width",
        orca_keys=("brim_width", "brim_type"),
    ),
    # Resin: modeled for variants and provenance; no qualified slicing pack exists.
    _p("resin", "printer", "display_width_mm", "Display width", unit="mm", minimum=1, maximum=1000),
    _p(
        "resin",
        "printer",
        "display_height_mm",
        "Display height",
        unit="mm",
        minimum=1,
        maximum=1000,
    ),
    _p(
        "resin",
        "printer",
        "display_pixels_x",
        "Display pixels X",
        "integer",
        minimum=1,
        maximum=100000,
    ),
    _p(
        "resin",
        "printer",
        "display_pixels_y",
        "Display pixels Y",
        "integer",
        minimum=1,
        maximum=100000,
    ),
    _p("resin", "material", "material_family", "Resin family", "choice", choices=RESIN_FAMILIES),
    _p("resin", "material", "exposure_time_s", "Exposure time", unit="s", minimum=0.1, maximum=600),
    _p(
        "resin",
        "material",
        "initial_exposure_time_s",
        "Initial exposure time",
        unit="s",
        minimum=0.1,
        maximum=600,
    ),
    _p(
        "resin", "process", "layer_height_mm", "Layer height", unit="mm", minimum=0.005, maximum=0.5
    ),
)
REGISTRY: dict[tuple[str, str, str], Parameter] = {
    (p.technology, p.role, p.key): p for p in PARAMETERS
}

Value = StrictFloat | StrictInt | StrictStr
PresetText = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9 @+()._-]{0,127}$")]


class VendorPreset(Strict):
    """A named preset from a vendor bundle shipped inside the slicer release.

    The preset is referenced by vendor, bundle version and name only; its contents stay in
    the pinned tool image. Declared parameters override it; undeclared settings come from
    it and are listed as preset settings, never copied into the record as declared values.
    """

    tool: Literal["orcaslicer-2.4.2"]
    vendor: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")]
    bundle_version: Annotated[str, Field(pattern=r"^[0-9]+(\.[0-9]+){1,4}$")]
    name: PresetText


class PrintProfile(Strict):
    schema_version: Literal["1"] = "1"
    role: Role
    technology: Technology
    parameters: dict[ParameterKey, Suggestion[Value]] = Field(default_factory=dict, max_length=64)
    vendor_preset: VendorPreset | None = None
    limitations: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(
        default_factory=list, max_length=50
    )

    @model_validator(mode="after")
    def known_parameters(self):
        if self.vendor_preset is not None and self.technology != "fdm":
            raise ValueError("Vendor slicer presets exist only for FDM profiles.")
        for key, suggestion in self.parameters.items():
            spec = REGISTRY.get((self.technology, self.role, key))
            if spec is None:
                raise ValueError(f"{key} is not a {self.technology} {self.role} parameter.")
            value = suggestion.value
            if value is None:
                continue
            if spec.type == "choice":
                if value not in spec.choices:
                    raise ValueError(f"{key} must be one of {', '.join(spec.choices)}.")
                continue
            if isinstance(value, str) or (spec.type == "integer" and not isinstance(value, int)):
                raise ValueError(f"{key} must be a {spec.type}.")
            if (spec.minimum is not None and value < spec.minimum) or (
                spec.maximum is not None and value > spec.maximum
            ):
                raise ValueError(f"{key} must be within {spec.minimum}..{spec.maximum}.")
        return self


class RevisionPin(Strict):
    revision_id: UUID
    snapshot_sha256: str = Field(pattern=SHA256)


class PartPin(Strict):
    """Exact mechanical model file; the mechanical definition is the part identity."""

    mechanical_revision_id: UUID
    snapshot_sha256: str = Field(pattern=SHA256)
    source_local_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    path: str = Field(min_length=1, max_length=512)

    @model_validator(mode="after")
    def portable(self):
        check_package_path(self.path)
        return self


Degrees = Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)]


class Orientation(Strict):
    """Rotation about X, then Y, then Z in degrees from the model's own frame."""

    status: Literal["unknown", "as_modeled", "rotated"] = "unknown"
    rotation_deg: tuple[Degrees, Degrees, Degrees] | None = None
    basis: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 1 preparations spelled the as-modeled status "as_modelled".
        if isinstance(value, dict) and value.get("status") == "as_modelled":
            return {**value, "status": "as_modeled"}
        return value

    @model_validator(mode="after")
    def coherent(self):
        if (self.status == "rotated") != (self.rotation_deg is not None):
            raise ValueError("Only a rotated orientation carries rotation angles.")
        if self.status != "unknown" and self.basis is None:
            raise ValueError("A declared orientation needs a basis.")
        return self


class Supports(Strict):
    status: Literal["unknown", "none", "auto", "buildplate_only"] = "unknown"
    basis: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def coherent(self):
        if self.status != "unknown" and self.basis is None:
            raise ValueError("A declared support strategy needs a basis.")
        return self


class ProfilePins(Strict):
    printer: RevisionPin
    process: RevisionPin
    material: RevisionPin


ORCA_TOOL_ID = "orcaslicer-2.4.2"
SLICER_TOOLS = (ORCA_TOOL_ID, "prusaslicer-2.5.0")
SlicerTool = Literal["orcaslicer-2.4.2", "prusaslicer-2.5.0"]


def upgrade_preparation_content(value):
    """Map schema 1 print preparation content to schema 2 without validating it: the
    "as_modelled" orientation status is now "as_modeled". Other content is unchanged."""
    if not isinstance(value, dict) or value.get("schema_version", "1") != "1":
        return value
    out = {**value, "schema_version": "2"}
    orientation = out.get("orientation")
    if isinstance(orientation, dict) and orientation.get("status") == "as_modelled":
        out["orientation"] = {**orientation, "status": "as_modeled"}
    return out


class PrintPreparation(Strict):
    schema_version: Literal["2"] = "2"
    variant_label: str = Field(min_length=1, max_length=200)
    technology: Technology
    part: PartPin
    model_units: Suggestion[Literal["mm", "in"]] = Field(
        default_factory=Suggestion[Literal["mm", "in"]]
    )
    profiles: ProfilePins
    orientation: Orientation = Field(default_factory=Orientation)
    supports: Supports = Field(default_factory=Supports)
    copies: int = Field(default=1, ge=1, le=32)
    output_format: Literal["gcode", "3mf"] = "gcode"
    slicer_tool: SlicerTool = ORCA_TOOL_ID
    limitations: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(
        default_factory=list, max_length=50
    )

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 1 (stored or submitted) is read through the schema 2 shape; the
        # orientation validator normalizes the status spelling.
        return upgrade_preparation_content(value)


class CreatePrintProfile(Strict):
    # Omitted: the actor's workspace. Profiles are library definitions.
    workspace_id: UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    print_profile: PrintProfile


class UpdatePrintProfile(Strict):
    draft_id: UUID
    print_profile: PrintProfile


class CreatePrintPreparation(Strict):
    workspace_id: UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    print_preparation: PrintPreparation


class UpdatePrintPreparation(Strict):
    draft_id: UUID
    print_preparation: PrintPreparation


class DraftRef(Strict):
    draft_id: UUID


class ReadRecord(Strict):
    draft_id: UUID | None = None
    revision_id: UUID | None = None

    @model_validator(mode="after")
    def one(self):
        if (self.draft_id is None) == (self.revision_id is None):
            raise ValueError("Read one draft or one frozen revision.")
        return self


class VariantsOf(Strict):
    mechanical_definition_id: UUID


class PreparationRef(Strict):
    preparation_revision_id: UUID


class RequestSlice(PreparationRef):
    recipe_id: str = Field(min_length=1, max_length=128)


class SliceRef(PreparationRef):
    build_id: UUID


class Estimate(Strict):
    value: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    status: Literal["slicer_estimate", "unknown"]

    @model_validator(mode="after")
    def coherent(self):
        if (self.status == "unknown") != (self.value is None):
            raise ValueError("Unknown estimates carry no value; estimates carry one.")
        return self


class Estimates(Strict):
    print_time_s: Estimate
    filament_length_mm: Estimate
    filament_mass_g: Estimate


class OutputDigest(Strict):
    path: str
    sha256: str = Field(pattern=SHA256)
    size: int = Field(gt=0)


class SliceReport(Strict):
    """Registered slicer report. Generation is not printability or qualification."""

    format_version: Literal[1]
    adapter: Literal["print-slice-prusaslicer-v1"]
    input_sha256: str = Field(pattern=SHA256)
    tool: dict[str, str]
    model_sha256: str = Field(pattern=SHA256)
    source_unchanged: Literal[True]
    slicer_exit_code: Literal[0]
    outputs: list[OutputDigest] = Field(min_length=2, max_length=2)
    estimates: Estimates
    printable: Literal["not_evaluated"]
    printer_submission: Literal["not_performed"]
    physical_qualification: Literal[False]


class OrcaEstimates(Estimates):
    """OrcaSlicer statements; layer count and volume are slicer-reported, not measured."""

    model_print_time_s: Estimate
    filament_volume_cm3: Estimate
    layer_count: Estimate


class PresetCheck(Strict):
    preset: str | list[str] | None
    declared: str | list[str]


class OrcaSliceReport(Strict):
    """Registered OrcaSlicer report. Generation is not printability or qualification."""

    format_version: Literal[1]
    adapter: Literal["print-slice-orcaslicer-v1"]
    input_sha256: str = Field(pattern=SHA256)
    tool: dict[str, str]
    producer: Literal["OrcaSlicer 2.4.2"]
    model_sha256: str = Field(pattern=SHA256)
    source_unchanged: Literal[True]
    slicer_exit_code: Literal[0]
    outputs: list[OutputDigest] = Field(min_length=2, max_length=3)
    estimates: OrcaEstimates
    applied_settings: dict[str, str | None]
    overrides: dict[Role, dict[str, PresetCheck]]
    gcode_body_sha256: str = Field(pattern=SHA256)
    printable: Literal["not_evaluated"]
    printer_submission: Literal["not_performed"]
    physical_qualification: Literal[False]


# Resin file inspection (UVtools) ---------------------------------------------------------


class ResinFileRef(Strict):
    """One sliced resin file (.ctb primary, .goo secondary) in a registered source bundle."""

    source_revision_id: UUID
    path: str = Field(min_length=1, max_length=512)

    @model_validator(mode="after")
    def portable(self):
        check_package_path(self.path)
        return self


class RequestResinInspection(ResinFileRef):
    recipe_id: str = Field(min_length=1, max_length=128)


class ResinInspectionRef(ResinFileRef):
    build_id: UUID


class ResinFact(Strict):
    value: float | str | None = None
    status: Literal["file_stated", "tool_computed", "unknown"]

    @model_validator(mode="after")
    def coherent(self):
        if (self.status == "unknown") != (self.value is None):
            raise ValueError("Unknown facts carry no value; stated facts carry one.")
        return self


RESIN_FACTS = (
    "machine_name",
    "resolution_x_px",
    "resolution_y_px",
    "display_width_mm",
    "display_height_mm",
    "pixel_width_um",
    "pixel_height_um",
    "layer_height_mm",
    "layer_count",
    "bottom_layer_count",
    "exposure_time_s",
    "bottom_exposure_time_s",
    "print_height_mm",
    "print_time_s",
    "material_ml",
    "material_g",
    "material_name",
    "volume_mm3",
    "computed_print_time_s",
    "display_on_time_s",
)


class ResinInspectionReport(Strict):
    """Registered UVtools inspection. Reading a file is not printability or qualification."""

    format_version: Literal[1]
    adapter: Literal["print-resin-inspect-uvtools-v1"]
    input_sha256: str = Field(pattern=SHA256)
    tool: dict[str, str]
    file_sha256: str = Field(pattern=SHA256)
    source_unchanged: Literal[True]
    tool_exit_code: Literal[0]
    outputs: list[OutputDigest] = Field(min_length=2, max_length=2)
    file_format: Literal["ctb", "ctb_encrypted", "goo"]
    format_class: str
    file_format_version: int | None
    facts: dict[str, ResinFact]
    printable: Literal["not_evaluated"]
    printer_submission: Literal["not_performed"]
    physical_qualification: Literal[False]

    @model_validator(mode="after")
    def complete(self):
        if set(self.facts) != set(RESIN_FACTS):
            raise ValueError("The inspection must list every resin fact, known or unknown.")
        return self
