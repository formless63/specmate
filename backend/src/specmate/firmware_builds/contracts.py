from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import Path, StrictModel


class FirmwareRef(StrictModel):
    firmware_revision_id: UUID
    assembly_snapshot_id: UUID | None = None
    path: Path = Field(default_factory=list)

    @model_validator(mode="after")
    def exact_occurrence(self):
        if bool(self.path) != bool(self.assembly_snapshot_id):
            raise ValueError("An occurrence requires its frozen assembly snapshot and exact path.")
        return self


class RequestCompile(FirmwareRef):
    recipe_id: str = Field(min_length=1, max_length=128)
    source_execution_authorized: Literal[True]
    basis: str = Field(min_length=1, max_length=2000, pattern=r"\S")
    resolved_configuration_id: UUID | None = None


class CompileRef(FirmwareRef):
    build_id: UUID


class ReproduceCompile(CompileRef):
    """Retry or re-run a compile; the same explicit source-execution consent is required."""

    source_execution_authorized: Literal[True]
    basis: str = Field(min_length=1, max_length=2000, pattern=r"\S")


class Output(StrictModel):
    path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size: int = Field(gt=0, le=16 * 1024**2)


class CompileReport(StrictModel):
    format_version: Literal[1]
    adapter: Literal["firmware-avr-gcc-v1"]
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    compiler_version: Literal["5.4.0"]
    tool_packages: dict[str, str]
    compiler_exit_code: Literal[0]
    source_unchanged: Literal[True]
    outputs: list[Output] = Field(min_length=4, max_length=4)
    hardware_compatibility: Literal["not_evaluated"]
    flashing: Literal["not_performed"]
    device_operation: Literal["not_observed"]
    physical_qualification: Literal[False]
