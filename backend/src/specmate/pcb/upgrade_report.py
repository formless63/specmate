"""Validate the bounded upgrade report; this module never parses CAD."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specmate.contracts import SHA256
from specmate.pcb.formats import (
    NATIVE_BOARD_FORMAT,
    NATIVE_KICAD,
    NATIVE_SCHEMATIC_FORMAT,
    UPGRADABLE_BOARD_FORMATS,
    UPGRADABLE_SCHEMATIC_FORMATS,
)
from specmate.pcb.pack import MAX_UPGRADE_SCHEMATICS, UPGRADED_PREFIX


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UpgradedFile(Record):
    path: str = Field(min_length=1, max_length=512)
    kind: Literal["board", "schematic"]
    output_path: str = Field(min_length=1, max_length=600)
    source_sha256: str = Field(pattern=SHA256)
    output_sha256: str = Field(pattern=SHA256)
    from_format_version: int
    from_kicad_major: Literal[6, 7, 8, 9, 10]
    to_format_version: int
    argv: list[str] = Field(max_length=4)

    @model_validator(mode="after")
    def recognized_versions(self):
        native, upgradable = (
            (NATIVE_BOARD_FORMAT, UPGRADABLE_BOARD_FORMATS)
            if self.kind == "board"
            else (NATIVE_SCHEMATIC_FORMAT, UPGRADABLE_SCHEMATIC_FORMATS)
        )
        if self.to_format_version != native:
            raise ValueError("upgrade must write the native KiCad 10 format")
        if self.output_path != UPGRADED_PREFIX + self.path:
            raise ValueError("upgraded output path must mirror the source path")
        if self.from_format_version == native:
            # Only an already-current schematic is carried over unchanged, without a run.
            if (
                self.kind == "board"
                or self.argv
                or self.from_kicad_major != NATIVE_KICAD
                or self.output_sha256 != self.source_sha256
            ):
                raise ValueError("a current-format file is carried over without an upgrade run")
            return self
        if upgradable.get(self.from_format_version) != self.from_kicad_major:
            raise ValueError("source format is not a recognized upgradable KiCad release")
        command = "pcb" if self.kind == "board" else "sch"
        if self.argv[:3] != ["kicad-cli", command, "upgrade"] or len(self.argv) != 4:
            raise ValueError("upgrade argv must be the pinned kicad-cli upgrade command")
        return self


class UpgradeReport(Record):
    format_version: Literal[1]
    adapter: Literal["kicad-format-upgrade-v1"]
    tool_version: Literal["10.0.6"]
    files: list[UpgradedFile] = Field(min_length=1, max_length=MAX_UPGRADE_SCHEMATICS + 1)
    unsupported: list[str] = Field(min_length=1, max_length=100)
    physical_qualification: Literal[False]

    @model_validator(mode="after")
    def one_board_first(self):
        kinds = [f.kind for f in self.files]
        if kinds[0] != "board" or kinds.count("board") != 1:
            raise ValueError("exactly one board, listed first, is upgraded")
        if len({f.path for f in self.files}) != len(self.files):
            raise ValueError("upgraded paths must be unique")
        return self

    @property
    def board(self) -> UpgradedFile:
        return self.files[0]
