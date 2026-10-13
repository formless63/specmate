"""Independent source assertions and comparison review; no source precedence."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, TypeAdapter, field_validator, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.contracts import SHA256, check_package_path

Text = Annotated[str, Field(min_length=1, max_length=500)]
Digest = Annotated[str, Field(pattern=SHA256)]


class FilePin(StrictModel):
    source_revision_id: UUID
    manifest_sha256: Digest
    path: str = Field(min_length=1, max_length=512)
    sha256: Digest
    rights: str = Field(min_length=1, max_length=200)

    @field_validator("path")
    @classmethod
    def portable(cls, value):
        return check_package_path(value)


class TerminalAssertion(StrictModel):
    local_id: LocalId
    component_ref: Text
    pin: Text
    native_component_id: Text | None = None
    native_terminal_id: Text | None = None
    net_state: Literal["assigned", "unconnected", "unknown"] = "unknown"
    net_name: Text | None = None
    basis: Text

    @model_validator(mode="after")
    def shape(self):
        if (self.net_state == "assigned") != (self.net_name is not None):
            raise ValueError("Only an assigned terminal has a declared net name.")
        return self


class Assertion(StrictModel):
    kind: Literal["pcb_assertion"] = "pcb_assertion"
    schema_version: Literal["1"] = "1"
    method: Literal["human_assertion"] = "human_assertion"
    source_role: Literal["pcb", "schematic", "netlist"]
    source: FilePin
    property_owner: Literal["preserved_source"] = "preserved_source"
    coverage: Literal["partial", "declared_complete"] = "partial"
    coverage_basis: Text
    terminals: list[TerminalAssertion] = Field(default_factory=list, max_length=2000)


class AssertionInput(StrictModel):
    kind: Literal["assertion_revision"] = "assertion_revision"
    revision_id: UUID
    snapshot_sha256: Digest


class BoardInput(StrictModel):
    kind: Literal["pcb_interpretation"] = "pcb_interpretation"
    interpretation_id: UUID
    report_sha256: Digest
    source: FilePin


class NativeInput(StrictModel):
    kind: Literal["source_net_interpretation"] = "source_net_interpretation"
    interpretation_id: UUID
    report_sha256: Digest
    source: FilePin


Input = Annotated[AssertionInput | BoardInput | NativeInput, Field(discriminator="kind")]


class Correspondence(StrictModel):
    local_id: LocalId
    left_terminal_id: Text | None = None
    right_terminal_id: Text | None = None
    basis: Text

    @model_validator(mode="after")
    def member(self):
        if self.left_terminal_id is None and self.right_terminal_id is None:
            raise ValueError("A correspondence must identify at least one exact terminal.")
        return self


class Review(StrictModel):
    finding_id: str = Field(pattern=r"^finding-[0-9a-f]{64}$")
    status: Literal["acknowledged", "requires_source_correction", "not_comparable"]
    basis: Text


class Comparison(StrictModel):
    kind: Literal["pcb_comparison"] = "pcb_comparison"
    schema_version: Literal["1"] = "1"
    left: Input
    right: Input
    correspondences: list[Correspondence] = Field(default_factory=list, max_length=2000)
    reviews: list[Review] = Field(default_factory=list, max_length=6000)


Value = Annotated[Assertion | Comparison, Field(discriminator="kind")]
VALUE_ADAPTER = TypeAdapter(Value)
KINDS = {"pcb_assertion", "pcb_comparison"}


class CreateReview(StrictModel):
    project_id: UUID
    name: Text
    value: Value


class UpdateReview(StrictModel):
    draft_id: UUID
    value: Value


class CaptureReview(StrictModel):
    draft_id: UUID


class ReadReview(StrictModel):
    revision_id: UUID
