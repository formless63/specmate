from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import Path, StrictModel


class InspectOccurrences(StrictModel):
    draft_id: UUID | None = None
    snapshot_id: UUID | None = None

    @model_validator(mode="after")
    def one_owner(self):
        if (self.draft_id is None) == (self.snapshot_id is None):
            raise ValueError("Inspect one assembly draft or one exact snapshot.")
        return self


class ReviewOccurrence(StrictModel):
    draft_id: UUID
    path: Path = Field(min_length=1)
    firmware_revision_id: UUID | None


class AdoptOccurrence(ReviewOccurrence):
    review_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    basis: str = Field(min_length=1, max_length=2000, pattern=r"\S")


class ReadAdoption(StrictModel):
    adoption_id: UUID
