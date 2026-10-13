from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

AssertionStatus = Literal["declared", "observed", "measured"]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class RegisterPhysicalUnit(Payload):
    revision_id: UUID
    serial: str = Field(min_length=1, max_length=200)
    origin: Literal["obtained", "assembled"]
    lot_id: UUID | None = None
    variant_id: UUID | None = None
    assertion_source: str = Field(min_length=1, max_length=1000)
    assertion_status: AssertionStatus = "declared"


class LinkWorkUnit(Payload):
    unit_id: UUID
    work_batch_id: UUID
    assertion_source: str = Field(min_length=1, max_length=1000)
    assertion_status: AssertionStatus = "declared"


class PhysicalUnitResult(BaseModel):
    unit_id: UUID
    project_id: UUID
    revision_id: UUID
    definition_id: UUID
    serial: str
    origin: Literal["obtained", "assembled"]
    lot_id: UUID | None
    variant_id: UUID | None
    assertion_source: str
    assertion_status: AssertionStatus
    registered_by_id: int
    request_id: str
    created_at: str
    work_batch_id: UUID | None
    physical_qualification: Literal[False] = False


class WorkUnitLinkResult(BaseModel):
    link_id: UUID
    unit_id: UUID
    work_batch_id: UUID
    assertion_source: str
    assertion_status: AssertionStatus
    linked_by_id: int
    request_id: str
    created_at: str
