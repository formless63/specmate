"""Descriptive product variants; exact design pins do not imply approval or edits."""

from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel


class OptionValue(StrictModel):
    local_id: LocalId
    label: str = Field(min_length=1, max_length=200)


class OptionAxis(OptionValue):
    values: list[OptionValue] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def unique(self):
        if len({value.local_id for value in self.values}) != len(self.values):
            raise ValueError("Option value IDs must be unique within their axis.")
        return self


class ProductVariant(StrictModel):
    local_id: LocalId
    label: str | None = Field(default=None, min_length=1, max_length=200)
    design_revision_id: UUID
    number: str | None = Field(default=None, min_length=1, max_length=200)
    declared_length_mm: Decimal | None = Field(
        default=None, gt=0, max_digits=14, decimal_places=4, allow_inf_nan=False
    )
    options: dict[LocalId, LocalId] = Field(default_factory=dict, max_length=16)
    note: str | None = Field(default=None, min_length=1, max_length=2000)


class ProductFamily(StrictModel):
    schema_version: Literal["1"]
    number: str | None = Field(default=None, min_length=1, max_length=200)
    options: list[OptionAxis] = Field(default_factory=list, max_length=16)
    variants: list[ProductVariant] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def references(self):
        axes = {axis.local_id: {value.local_id for value in axis.values} for axis in self.options}
        if len(axes) != len(self.options):
            raise ValueError("Option axis IDs must be unique.")
        if len({variant.local_id for variant in self.variants}) != len(self.variants):
            raise ValueError("Variant IDs must be unique within their family.")
        for variant in self.variants:
            for axis, value in variant.options.items():
                if axis not in axes or value not in axes[axis]:
                    raise ValueError("A variant may select only a declared option value.")
        return self


class LineupQuery(StrictModel):
    workspace_id: UUID
    project_id: UUID | None = None
    limit: int = Field(default=25, ge=1, le=100)
    after: str | None = Field(default=None, max_length=3000)


class ExactIdentity(StrictModel):
    definition_id: UUID
    revision_id: UUID
    name: str
    kind: str
    number: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class SelectedOption(StrictModel):
    axis_id: LocalId
    axis_label: str
    value_id: LocalId
    value_label: str


class LineupRow(StrictModel):
    family: ExactIdentity
    family_number: str | None
    variant: ProductVariant
    selected_options: list[SelectedOption]
    design: ExactIdentity
    in_project: bool | None = None


class LineupResult(StrictModel):
    results: list[LineupRow]
    as_of: str
    basis: Literal["latest_frozen_family_at_page_anchor_current_authority"]
    next_after: str | None


class VersionsQuery(StrictModel):
    definition_id: UUID
    offset: int = Field(default=0, ge=0, le=1_000_000)
    limit: int = Field(default=25, ge=1, le=50)


class FrozenChoice(ExactIdentity):
    pass


class DraftChoice(StrictModel):
    draft_id: UUID
    version: int = Field(ge=1)
    label: str


class VersionsResult(StrictModel):
    revisions: list[FrozenChoice]
    drafts: list[DraftChoice]
    next_offset: int | None
