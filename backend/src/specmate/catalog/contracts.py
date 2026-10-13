from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

RepresentationKind = Literal["symbol", "footprint", "model", "drawing", "datasheet"]


class RegisterVariant(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision_id: UUID
    manufacturer: str = Field(min_length=1, max_length=200)
    part_number: str = Field(min_length=1, max_length=200)
    association_basis: str = Field(min_length=1, max_length=4000)


class RegisterRepresentation(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision_id: UUID
    kind: RepresentationKind
    label: str = Field(min_length=1, max_length=200)
    source_bundle_revision_id: UUID
    source_path: Annotated[str, StringConstraints(strip_whitespace=False)] = Field(
        min_length=1, max_length=512
    )


class VariantResult(BaseModel):
    variant_id: UUID
    revision_id: UUID
    definition_id: UUID
    manufacturer: str
    part_number: str
    association_basis: str


class RepresentationResult(BaseModel):
    representation_id: UUID
    revision_id: UUID
    definition_id: UUID
    kind: RepresentationKind
    label: str
    source_bundle_revision_id: UUID
    source_path: str
    sha256: str
    media_type: str
    rights: str


class RegisterLot(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision_id: UUID
    variant_id: UUID | None = None
    label: str = Field(min_length=1, max_length=200)


class LotResult(BaseModel):
    lot_id: UUID
    revision_id: UUID
    definition_id: UUID
    variant_id: UUID | None
    label: str
