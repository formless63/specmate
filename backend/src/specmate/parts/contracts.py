"""Optional descriptions are not electrical facts; kits are not physical assemblies."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.inventory.contracts import Quantity


class DeclaredFit(StrictModel):
    revision_id: UUID
    basis: str = Field(min_length=1, max_length=2000)


class Part(StrictModel):
    # Explicit opt-in: legacy arbitrary part content remains unchanged.
    schema_version: Literal["1"]
    category: str | None = Field(default=None, min_length=1, max_length=100)
    value: str | None = Field(default=None, min_length=1, max_length=500)
    package: str | None = Field(default=None, min_length=1, max_length=200)
    fits: list[DeclaredFit] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique(self):
        if len({row.revision_id for row in self.fits}) != len(self.fits):
            raise ValueError("Each declared fit target occurs once.")
        return self


class KitLine(StrictModel):
    local_id: LocalId
    revision_id: UUID
    quantity: Quantity | None = None
    note: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def positive(self):
        if self.quantity is not None and self.quantity.amount <= 0:
            raise ValueError("A known kit quantity must be positive.")
        return self


class Kit(StrictModel):
    schema_version: Literal["1"]
    semantics: Literal["catalog_grouping"] = "catalog_grouping"
    lines: list[KitLine] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def unique(self):
        if len({row.local_id for row in self.lines}) != len(self.lines):
            raise ValueError("Kit line IDs must be unique.")
        return self


class KitPage(StrictModel):
    after: str | None = Field(default=None, max_length=2000)
    limit: int = Field(default=20, ge=1, le=50)


class ReadKits(KitPage):
    revision_id: UUID


class RecordSelection(StrictModel):
    include_content: bool = True
    revision_number: int | None = Field(default=None, ge=1, le=2_147_483_647)
    working: bool = False
    draft_id: UUID | None = None

    @model_validator(mode="after")
    def selected_state(self):
        if self.revision_number is not None and (self.working or self.draft_id is not None):
            raise ValueError("Select either an exact revision or a working draft.")
        return self


class ReadRecord(RecordSelection):
    definition_id: UUID


class RecordResult(BaseModel):
    # Outbound legacy labels and arbitrary saved JSON remain byte-for-byte text.
    model_config = ConfigDict(extra="forbid")


class SelectedDraft(RecordResult):
    kind: Literal["draft"]
    draft_id: UUID
    state: str
    base_revision_id: UUID | None = None
    content: dict[str, JsonValue] | None = None


class SelectedRevision(RecordResult):
    kind: Literal["revision"]
    revision_id: UUID
    number: int = Field(ge=1)
    snapshot_id: UUID
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    content: dict[str, JsonValue] | None = None


class CatalogRecord(RecordResult):
    definition_id: UUID
    workspace_id: UUID
    name: str
    kind: str
    selected: Annotated[SelectedDraft | SelectedRevision, Field(discriminator="kind")]
