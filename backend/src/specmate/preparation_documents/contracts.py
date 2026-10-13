"""One frozen root and explicit immutable supplementary document inputs."""

from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from specmate.assemblies.contracts import LocalId, Path, StrictModel
from specmate.preparation.contracts import Application
from specmate.selected_packages.contracts import RightsReview

GENERATOR = "specmate.preparation-documents/1"
FORMAT = "specmate.coordinated-document-set/0.1"
DOCUMENTS = (
    "specifications.json",
    "schematic.svg",
    "cut-preparation.csv",
    "build-sheet.html",
    "terminations.json",
    "test-intent.json",
)


class EndBinding(StrictModel):
    section_id: LocalId | None = None
    profile_revision_id: UUID
    a_end_id: LocalId | None = None
    b_end_id: LocalId | None = None
    mapping_review: Literal["unreviewed", "reviewed"] = "unreviewed"
    mapping_basis: str = Field(min_length=1, max_length=2000)

    @field_validator("mapping_basis")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Mapping basis cannot be blank.")
        return value.strip()


class Binding(StrictModel):
    occurrence_path: Path = Field(default_factory=list)
    cut_profiles: list[Application] = Field(default_factory=list, max_length=256)
    end_profiles: list[EndBinding] = Field(default_factory=list, max_length=256)
    test_plan_revision_id: UUID | None = None

    @model_validator(mode="after")
    def unique(self):
        for rows in (self.cut_profiles, self.end_profiles):
            if len({row.section_id for row in rows}) != len(rows):
                raise ValueError("Each physical section has at most one profile of each kind.")
        return self


class Configuration(StrictModel):
    root_revision_id: UUID
    quantity: int | None = Field(default=1, ge=1, le=1_000_000, strict=True)
    bom_plan_revision_id: UUID | None = None
    standalone_decision: Literal["make", "buy", "unknown"] = "unknown"
    standalone_basis: str | None = Field(default=None, min_length=1, max_length=2000)
    bindings: list[Binding] = Field(default_factory=list, max_length=256)
    purpose: Literal["authorized_review", "distribution"] = "authorized_review"
    rights_reviews: list[RightsReview] = Field(default_factory=list, max_length=4000)
    output_rights: str = Field(default="unknown", min_length=1, max_length=200)
    output_rights_basis: str | None = Field(default=None, min_length=1, max_length=2000)

    @field_validator("standalone_basis", "output_rights", "output_rights_basis")
    @classmethod
    def nonblank(cls, value):
        if value is not None and not value.strip():
            raise ValueError("A declared rights or decision basis cannot be blank.")
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def unique(self):
        if len({tuple(b.occurrence_path) for b in self.bindings}) != len(self.bindings):
            raise ValueError("Bind each exact contextual wiring occurrence once.")
        if len({r.subject for r in self.rights_reviews}) != len(self.rights_reviews):
            raise ValueError("Review each exact rights subject once.")
        if self.standalone_decision != "unknown" and self.standalone_basis is None:
            raise ValueError("A standalone make/buy declaration needs a basis.")
        return self


class SetRef(StrictModel):
    document_set_id: UUID


class Download(SetRef):
    filename: Literal[
        "specifications.json",
        "schematic.svg",
        "cut-preparation.csv",
        "build-sheet.html",
        "terminations.json",
        "test-intent.json",
    ]


class InputAuthority(StrictModel):
    """Reference authorization only: no quantities, mappings or declaration assessment."""

    root_revision_id: UUID
    supplementary_revision_ids: list[UUID] = Field(default_factory=list, max_length=1023)

    @model_validator(mode="after")
    def unique(self):
        if (
            len(set(self.supplementary_revision_ids)) != len(self.supplementary_revision_ids)
            or self.root_revision_id in self.supplementary_revision_ids
        ):
            raise ValueError("Supplementary pins must be unique and distinct from the root.")
        return self
