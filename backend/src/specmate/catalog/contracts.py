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


class RegisterSourceIdentifier(BaseModel):
    """A reference to an external source (library id, URL, standard) with explicit rights.

    Nothing is fetched. ``rights`` may state ``unknown`` but may never be omitted.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision_id: UUID
    scheme: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    identifier: str = Field(min_length=1, max_length=512)
    label: str = Field(min_length=1, max_length=200)
    rights: str = Field(min_length=1, max_length=200)


class SourceIdentifierResult(BaseModel):
    source_identifier_id: UUID
    revision_id: UUID
    revision_number: int
    definition_id: UUID
    definition_name: str
    scheme: str
    identifier: str
    label: str
    rights: str
    rights_known: bool


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
    revision_number: int
    definition_id: UUID
    definition_name: str
    definition_kind: str
    kind: RepresentationKind
    label: str
    source_bundle_revision_id: UUID
    source_path: str
    sha256: str
    media_type: str
    rights: str
    rights_known: bool


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
