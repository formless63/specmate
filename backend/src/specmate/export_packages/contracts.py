"""One exact root, an explicit scope quantity and existing retained outputs to coordinate."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.bom.contracts import Purpose
from specmate.contracts import SHA256


class PcbBuildRef(StrictModel):
    intake_id: UUID
    build_id: UUID


class ExportRequest(StrictModel):
    root_revision_id: UUID
    # Root units in scope. None keeps every derived scope quantity explicitly unknown.
    quantity: int | None = Field(default=None, ge=1, le=1_000_000, strict=True)
    bom_plan_revision_id: UUID | None = None
    bom_purpose: Purpose = "procurement"
    preparation_document_set_ids: list[UUID] = Field(default_factory=list, max_length=64)
    test_plan_revision_ids: list[UUID] = Field(default_factory=list, max_length=256)
    pcb_fabrication_builds: list[PcbBuildRef] = Field(default_factory=list, max_length=64)
    scene_drawing_ids: list[UUID] = Field(default_factory=list, max_length=64)
    purpose: Literal["authorized_review"] = "authorized_review"

    @model_validator(mode="after")
    def unique(self):
        for values in (
            self.preparation_document_set_ids,
            self.test_plan_revision_ids,
            self.scene_drawing_ids,
            [b.build_id for b in self.pcb_fabrication_builds],
        ):
            if len(set(values)) != len(values):
                raise ValueError("Include each exact retained output once.")
        return self


class Download(ExportRequest):
    reviewed_sha256: str = Field(pattern=SHA256)
