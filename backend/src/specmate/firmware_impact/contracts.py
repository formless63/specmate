from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.firmware_builds.contracts import FirmwareRef


class CompareImpact(StrictModel):
    project_id: UUID
    baseline: FirmwareRef
    candidate: FirmwareRef
    assertion_ids: list[UUID] = Field(default_factory=list, max_length=100)
    observation_offset: int = Field(default=0, ge=0, le=5000)

    @model_validator(mode="after")
    def unique_assertions(self):
        if len(set(self.assertion_ids)) != len(self.assertion_ids):
            raise ValueError("Select each historical assertion once.")
        return self
