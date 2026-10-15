"""Practices are suggestions about preparation or depiction, never stock facts."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, model_validator

from specmate.contracts import SHA256, check_package_path
from specmate.operations import ValidationFailed

Millimeters = Annotated[float, Field(ge=0, strict=True, allow_inf_nan=False)]
Degrees = Annotated[float, Field(ge=-360, le=360, strict=True, allow_inf_nan=False)]
ElementPath = Annotated[
    str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}(\.[a-z][a-z0-9_-]{0,63}){0,12}$")
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class Citation(StrictModel):
    kind: Literal["citation"]
    citation: str = Field(min_length=1, max_length=2000)


class SourceFile(StrictModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False, allow_inf_nan=False)

    kind: Literal["source_file"]
    bundle_revision_id: UUID
    path: str = Field(min_length=1, max_length=512)
    locator: str = Field(default="", max_length=200)
    sha256: str = Field(pattern=SHA256)
    rights: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def safe_path(self):
        check_package_path(self.path)
        return self


Source = Annotated[Citation | SourceFile, Field(discriminator="kind")]
Basis = Literal["unknown", "documented", "inferred", "preference"]


class Suggestion[T](StrictModel):
    value: T | None = None
    basis: Basis = "unknown"
    source: Source | None = None
    note: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def coherent(self):
        if (self.basis == "unknown") != (self.value is None):
            raise ValueError("Unknown practices have no value; known practices require one.")
        if self.basis == "documented" and self.source is None:
            raise ValueError("Documented practices require a cited source.")
        if self.basis in {"inferred", "preference"} and self.note is None:
            raise ValueError("Inferred or preferred practices require a basis note.")
        if self.basis == "unknown" and self.source is not None:
            raise ValueError("An unknown practice cannot cite evidence for a value.")
        return self


class LeadDisplay(StrictModel):
    """Illustrative pigtail strand, with no electrical bond assertion."""

    length_mm: Suggestion[Millimeters] = Field(default_factory=Suggestion[Millimeters])
    diameter_mm: Suggestion[Millimeters] = Field(default_factory=Suggestion[Millimeters])
    reach_mm: Suggestion[Millimeters] = Field(default_factory=Suggestion[Millimeters])
    angle_deg: Suggestion[Degrees] = Field(default_factory=Suggestion[Degrees])


class EndPractice(StrictModel):
    cutback_mm: Suggestion[Millimeters] = Field(default_factory=Suggestion[Millimeters])
    prepend_cut_mm: Suggestion[Millimeters] = Field(default_factory=Suggestion[Millimeters])
    lead: LeadDisplay | None = None


class ElementPractice(StrictModel):
    a: EndPractice = Field(default_factory=EndPractice)
    b: EndPractice = Field(default_factory=EndPractice)


class WorkshopProfile(StrictModel):
    schema_version: Literal["1"] = "1"
    stock_revision_id: UUID
    foil_visibility: Suggestion[Literal["show", "hide"]] = Field(
        default_factory=Suggestion[Literal["show", "hide"]]
    )
    illustration_lay_length_mm: Suggestion[Millimeters] = Field(
        default_factory=Suggestion[Millimeters]
    )
    # Depiction rotation about +x as x increases; phase zero at end A.
    # Independent of stock ring placement and any measured engineering lay.
    illustration_lay_direction: Suggestion[Literal["positive", "negative"]] = Field(
        default_factory=Suggestion[Literal["positive", "negative"]]
    )
    omit_occluded: Suggestion[StrictBool] = Field(default_factory=Suggestion[StrictBool])
    element_rules: dict[ElementPath, ElementPractice] = Field(default_factory=dict, max_length=1024)
    hidden_element_paths: list[ElementPath] = Field(default_factory=list, max_length=1024)

    @model_validator(mode="after")
    def unique_paths(self):
        if len(set(self.hidden_element_paths)) != len(self.hidden_element_paths):
            raise ValueError("Hidden element paths must be unique.")
        return self


def validate_profile_content(content: dict) -> dict:
    """A generic unfinished draft may omit the profile; a present one must be typed."""
    if "profile" not in content:
        return content
    try:
        profile = WorkshopProfile.model_validate(content["profile"])
    except ValidationError as exc:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        raise ValidationFailed("Invalid workshop profile.", details={"errors": errors}) from None
    return {**content, "profile": profile.model_dump(mode="json")}
