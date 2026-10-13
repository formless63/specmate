"""Mechanical source declarations. No native geometry is parsed by these contracts."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.contracts import SHA256, check_package_path

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
        if self.role == "board" and not self.board:
            raise ValueError("A board target needs exact board interpretation/source pins.")
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


class MechanicalSource(Strict):
    schema_version: Literal["1"] = "1"
    item_role: Literal["enclosure", "part", "hardware"]
    sources: list[SourcePin] = Field(min_length=1, max_length=32)
    targets: list[TargetPin] = Field(default_factory=list, max_length=100)
    models: list[ModelPin] = Field(default_factory=list, max_length=100)
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
        if any(not text.strip() or len(text) > 2000 for text in self.limitations):
            raise ValueError("Limitations must be nonempty bounded statements.")
        return self


class CreateMechanicalSource(Strict):
    project_id: UUID
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
