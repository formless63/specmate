"""Maker preference contracts. Preferences carry names and units only: there is no field
for a rating, tolerance or compatibility, so a preference cannot assert one."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]

KEYS = (
    "preferred_suppliers",
    "wire_colors",
    "connector_families",
    "default_length_unit",
    "default_wire_gauge_system",
)


class PreferenceValues(BaseModel):
    """Only fields present in the request change; an explicit null clears (unsets) one."""

    model_config = ConfigDict(extra="forbid")

    preferred_suppliers: list[Name] | None = Field(default=None, max_length=30)
    wire_colors: list[Name] | None = Field(default=None, max_length=30)
    connector_families: list[Name] | None = Field(default=None, max_length=30)
    default_length_unit: Literal["mm", "cm", "m", "in", "ft"] | None = None
    default_wire_gauge_system: Literal["awg", "mm2"] | None = None

    @field_validator("*", mode="after")
    @classmethod
    def distinct(cls, value):
        if isinstance(value, list):
            folded = [item.casefold() for item in value]
            if len(set(folded)) != len(folded):
                raise ValueError("Entries must be distinct.")
        return value


class SetPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: UUID
    # "workspace" sets the shared defaults (design.edit); "user" sets the caller's own override.
    scope: Literal["workspace", "user"]
    values: PreferenceValues
