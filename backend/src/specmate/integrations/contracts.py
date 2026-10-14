"""Typed integration payloads. Field ownership is a closed vocabulary; nothing is implied."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Synchronizable fields. Engineering facts (definitions, revisions, the stock ledger) are
# deliberately absent: they cannot be declared externally owned.
Field_ = Literal["supplier_offer", "stock_observation", "needs"]
Owner = Literal["external", "specmate"]
# Direction each field may flow; the declared owner must match it.
IMPORT_FIELDS = {"supplier_offer", "stock_observation"}
EXPORT_FIELDS = {"needs"}
FileFormat = Literal["csv", "json"]
MAX_CONTENT = 2_000_000


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class _Config(Payload):
    ownership: dict[Field_, Owner] = Field(min_length=1)
    columns: dict[str, str] = Field(default_factory=dict, max_length=40)

    @model_validator(mode="after")
    def coherent(self):
        for name, owner in self.ownership.items():
            if name in IMPORT_FIELDS and owner != "external":
                raise ValueError(f"{name} can only be declared externally owned.")
            if name in EXPORT_FIELDS and owner != "specmate":
                raise ValueError(f"{name} is owned here and can only be exported.")
        return self


class CreateIntegration(_Config):
    workspace_id: UUID
    name: str = Field(min_length=1, max_length=200)


class UpdateIntegration(_Config):
    integration_id: UUID
    enabled: bool = True


class ImportObservations(Payload):
    integration_id: UUID
    field: Literal["supplier_offer", "stock_observation"]
    file_name: str = Field(min_length=1, max_length=300)
    file_format: FileFormat
    content: str = Field(min_length=1, max_length=MAX_CONTENT)


class ExportNeeds(Payload):
    integration_id: UUID
    # A frozen bom_plan or material_plan revision.
    revision_id: UUID
    purpose: Literal["procurement", "pcb_fabrication", "pcb_population", "consumables"] = (
        "procurement"
    )
    file_format: FileFormat = "csv"


class PromoteObservation(Payload):
    observation_id: UUID
    # The reviewer's own basis; the actor becomes the offer's reviewer.
    review_basis: str = Field(min_length=1, max_length=4000)


class PromoteResult(BaseModel):
    observation_id: UUID
    offer: dict
    already_promoted: bool


class IntegrationResult(BaseModel):
    integration_id: UUID
    workspace_id: UUID
    name: str
    adapter: str
    ownership: dict[str, str]
    columns: dict[str, str]
    enabled: bool
    state: UUID
    created_by: dict
    updated_by: dict
    created_at: str
    updated_at: str


class ImportResult(BaseModel):
    run_id: UUID
    integration_id: UUID
    field: str
    file_sha256: str
    row_count: int
    accepted_count: int
    rejected_count: int
    rejections: list[dict]
    duplicate_of_earlier_run: bool
    observations_are_not_engineering_facts: bool
    ledger_written: bool
    actor: dict
    created_at: str


class ExportResult(BaseModel):
    export_id: UUID
    integration_id: UUID
    revision_id: UUID
    purpose: str
    file_format: str
    file_sha256: str
    row_count: int
    unresolved: list[dict]
    content: str
    actor: dict
    created_at: str
