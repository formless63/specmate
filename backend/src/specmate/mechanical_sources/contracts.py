"""Mechanical source declarations. No native geometry is parsed by these contracts."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.contracts import SHA256, check_package_path
from specmate.operations.scope import WorkspacePayload

KIND = "mechanical_source"
KEY = "mechanical_source"
LOCAL = r"^[a-z][a-z0-9_-]{0,63}$"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SourceFile(Strict):
    path: str = Field(min_length=1, max_length=512)
    sha256: str = Field(pattern=SHA256)
    rights: str = Field(min_length=1, max_length=200)
    role: Literal["native", "recipe", "model", "supporting", "unsupported"]
    format: Literal["freecad", "build123d", "cadquery", "step", "brep", "mesh", "other"]

    @model_validator(mode="after")
    def portable(self):
        check_package_path(self.path)
        return self


class SourcePin(Strict):
    local_id: str = Field(pattern=LOCAL)
    source_revision_id: UUID
    source_manifest_sha256: str = Field(pattern=SHA256)
    files: list[SourceFile] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def unique(self):
        if len({f.path for f in self.files}) != len(self.files):
            raise ValueError("Each source file path occurs once.")
        return self


class BoardPin(Strict):
    interpretation_id: UUID
    interpretation_sha256: str = Field(pattern=SHA256)
    source_revision_id: UUID
    source_manifest_sha256: str = Field(pattern=SHA256)
    option_id: str | None = Field(default=None, pattern=LOCAL)


class TargetPin(Strict):
    local_id: str = Field(pattern=LOCAL)
    role: Literal["board", "component", "hardware"]
    revision_id: UUID
    snapshot_sha256: str = Field(pattern=SHA256)
    board: BoardPin | None = None
    native_component_id: UUID | None = None
    basis: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def native_scope(self):
        if self.native_component_id is not None and (self.role != "component" or not self.board):
            raise ValueError("A native component needs a component target and exact board pins.")
        return self


class ModelPin(Strict):
    local_id: str = Field(pattern=LOCAL)
    representation_id: UUID
    revision_id: UUID
    snapshot_sha256: str = Field(pattern=SHA256)
    source_local_id: str = Field(pattern=LOCAL)
    path: str = Field(min_length=1, max_length=512)
    target_local_id: str = Field(pattern=LOCAL)
    purpose: Literal["manufacturing", "clearance", "illustration"]
    units: Literal["mm", "m", "in"] | None = None
    frame: str | None = Field(default=None, min_length=1, max_length=200)
    accuracy: str | None = Field(default=None, min_length=1, max_length=2000)
    basis: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def portable(self):
        check_package_path(self.path)
        return self


AssumptionStatus = Literal["unknown", "declared", "not_applicable"]
Millimetres = Annotated[float, Field(allow_inf_nan=False, ge=-1_000_000, le=1_000_000)]
VectorMM = tuple[Millimetres, Millimetres, Millimetres]


class ScopedAssumption(Strict):
    local_id: str = Field(pattern=LOCAL)
    # None explicitly scopes this to the mechanical item itself, not all targets.
    target_local_id: str | None = Field(default=None, pattern=LOCAL)
    status: AssumptionStatus = "unknown"
    basis: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def justification(self):
        if self.status != "unknown" and self.basis is None:
            raise ValueError("Declared or not-applicable assumptions need an explicit basis.")
        return self


class MaterialAssumption(ScopedAssumption):
    specification: str | None = Field(default=None, min_length=1, max_length=2000)
    behavior: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def declaration(self):
        if self.status == "declared" and self.specification is None:
            raise ValueError("A declared material needs a specification.")
        if self.status != "declared" and (self.specification or self.behavior):
            raise ValueError("Unknown/not-applicable material stores no material facts.")
        return self


class ProcessAssumption(ScopedAssumption):
    method: str | None = Field(default=None, min_length=1, max_length=2000)
    parameters: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(
        default_factory=list, max_length=32
    )
    behavior: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def declaration(self):
        if self.status == "declared" and self.method is None:
            raise ValueError("A declared process needs a method.")
        if self.status != "declared" and (self.method or self.parameters or self.behavior):
            raise ValueError("Unknown/not-applicable process stores no process facts.")
        return self


class ToleranceAssumption(ScopedAssumption):
    model_local_id: str | None = Field(default=None, pattern=LOCAL)
    dimension: str = Field(min_length=1, max_length=200)
    units: Literal["mm"] = "mm"
    lower_deviation: Millimetres | None = None
    upper_deviation: Millimetres | None = None

    @model_validator(mode="after")
    def bounds(self):
        if self.status == "declared":
            if self.lower_deviation is None or self.upper_deviation is None:
                raise ValueError("Declared tolerance needs both deviation bounds in mm.")
            if self.lower_deviation > self.upper_deviation:
                raise ValueError("Tolerance lower deviation must not exceed upper deviation.")
        elif self.lower_deviation is not None or self.upper_deviation is not None:
            raise ValueError("Unknown/not-applicable tolerance stores no numeric bounds.")
        return self


class ConnectorEnvelope(ScopedAssumption):
    target_local_id: str = Field(pattern=LOCAL)
    usage: Literal["body", "mated", "installation", "cable_route"]
    units: Literal["mm"] = "mm"
    minimum: VectorMM | None = None
    maximum: VectorMM | None = None
    frame: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def bounds(self):
        if self.status == "declared":
            if self.minimum is None or self.maximum is None or self.frame is None:
                raise ValueError("Declared envelope needs min/max XYZ in mm and an explicit frame.")
            if any(lo > hi for lo, hi in zip(self.minimum, self.maximum, strict=True)):
                raise ValueError("Envelope minimum must not exceed maximum on each axis.")
        elif self.minimum is not None or self.maximum is not None or self.frame is not None:
            raise ValueError("Unknown/not-applicable envelope stores no bounds or frame.")
        return self


class MechanicalUncertainty(Strict):
    materials: list[MaterialAssumption] = Field(default_factory=list, max_length=100)
    processes: list[ProcessAssumption] = Field(default_factory=list, max_length=100)
    tolerances: list[ToleranceAssumption] = Field(default_factory=list, max_length=100)
    connector_envelopes: list[ConnectorEnvelope] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique(self):
        for rows in (self.materials, self.processes, self.tolerances, self.connector_envelopes):
            if len({row.local_id for row in rows}) != len(rows):
                raise ValueError("Assumption local IDs are unique in each collection.")
        scopes = [(row.target_local_id, row.usage) for row in self.connector_envelopes]
        if len(set(scopes)) != len(scopes):
            raise ValueError("A connector target/usage scope occurs once.")
        return self


class MechanicalSource(Strict):
    schema_version: Literal["1"] = "1"
    item_role: Literal["enclosure", "part", "hardware"]
    sources: list[SourcePin] = Field(min_length=1, max_length=32)
    targets: list[TargetPin] = Field(default_factory=list, max_length=100)
    models: list[ModelPin] = Field(default_factory=list, max_length=100)
    uncertainty: MechanicalUncertainty = Field(default_factory=MechanicalUncertainty)
    limitations: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def local_references(self):
        for rows in (self.sources, self.targets, self.models):
            if len({r.local_id for r in rows}) != len(rows):
                raise ValueError("Local IDs are unique in each collection.")
        source_files = {s.local_id: {f.path: f for f in s.files} for s in self.sources}
        targets = {t.local_id for t in self.targets}
        for model in self.models:
            if model.target_local_id not in targets:
                raise ValueError("A model must identify an explicitly pinned target.")
            file = source_files.get(model.source_local_id, {}).get(model.path)
            if file is None or file.role != "model":
                raise ValueError("A model must identify an explicitly pinned model source file.")
        for rows in (
            self.uncertainty.materials,
            self.uncertainty.processes,
            self.uncertainty.tolerances,
            self.uncertainty.connector_envelopes,
        ):
            for row in rows:
                if row.target_local_id is not None and row.target_local_id not in targets:
                    raise ValueError(
                        "An assumption must scope an explicitly pinned target or the item."
                    )
        for row in self.uncertainty.tolerances:
            if row.model_local_id is not None:
                model = next((m for m in self.models if m.local_id == row.model_local_id), None)
                if model is None or model.target_local_id != row.target_local_id:
                    raise ValueError(
                        "A model tolerance must identify its exact local model and target."
                    )
        if any(not text.strip() or len(text) > 2000 for text in self.limitations):
            raise ValueError("Limitations must be nonempty bounded statements.")
        return self


class CreateMechanicalSource(Strict, WorkspacePayload):
    name: str = Field(min_length=1, max_length=200)
    mechanical_source: MechanicalSource


class UpdateMechanicalSource(Strict):
    draft_id: UUID
    mechanical_source: MechanicalSource


class DraftRef(Strict):
    draft_id: UUID


class ReadMechanicalSource(Strict):
    draft_id: UUID | None = None
    revision_id: UUID | None = None

    @model_validator(mode="after")
    def one(self):
        if (self.draft_id is None) == (self.revision_id is None):
            raise ValueError("Read one draft or one frozen revision.")
        return self
