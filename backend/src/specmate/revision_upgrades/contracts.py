"""Deliberate exact-pin adoption; review is separate from engineering validity."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import FeatureId, LocalId, Path, StrictModel
from specmate.catalog_matching.contracts import EvidenceInput


class ProposeUpgrade(StrictModel):
    """Selected occurrences of one exact consuming context and one explicit identity pair.

    `later_revision` keeps the same definition. `declared_replacement` names a different
    definition of the same kind; its human declaration is the only correspondence basis,
    never label equality or a catalog matching association. `context_path` reaches a
    nested consuming subassembly in the owning snapshot; `paths` are relative to it.
    """

    owning_snapshot_id: UUID
    old_revision_id: UUID
    candidate_revision_id: UUID
    relation: Literal["later_revision", "declared_replacement"] = "later_revision"
    replacement_basis: str | None = Field(default=None, min_length=1, max_length=4000)
    context_path: Path = Field(default_factory=list)
    paths: list[Path] = Field(min_length=1, max_length=1000)
    basis: str = Field(min_length=1, max_length=4000)

    @model_validator(mode="after")
    def unique_paths(self):
        if len({tuple(p) for p in self.paths}) != len(self.paths):
            raise ValueError("Selected paths must be unique.")
        if (self.relation == "declared_replacement") != (self.replacement_basis is not None):
            raise ValueError("Only a declared replacement carries a replacement declaration.")
        return self


class FeatureCorrespondence(StrictModel):
    path: Path = Field(min_length=1)
    old_feature_id: FeatureId
    candidate_feature_id: FeatureId
    basis: str = Field(min_length=1, max_length=4000)


class RelationshipDecision(StrictModel):
    """Explicitly retain or remove one consuming-context relationship to a changed use."""

    local_id: LocalId
    decision: Literal["retain", "remove"]
    basis: str = Field(min_length=1, max_length=4000)


class AssignmentDecision(StrictModel):
    """Explicitly retain or remove an occurrence assignment on a changed use."""

    path: Path = Field(min_length=1)
    decision: Literal["retain", "remove"]
    basis: str = Field(min_length=1, max_length=4000)


class ImpactAssessment(StrictModel):
    status: Literal["not_evaluated", "unknown", "reviewed"] = "not_evaluated"
    basis: str | None = Field(default=None, min_length=1, max_length=4000)

    @model_validator(mode="after")
    def reviewed_basis(self):
        if self.status == "reviewed" and not self.basis:
            raise ValueError("Reviewed impact requires a basis.")
        return self


class Impacts(StrictModel):
    electrical: ImpactAssessment = Field(default_factory=ImpactAssessment)
    mechanical: ImpactAssessment = Field(default_factory=ImpactAssessment)
    firmware: ImpactAssessment = Field(default_factory=ImpactAssessment)
    manufacturing: ImpactAssessment = Field(default_factory=ImpactAssessment)
    evidence: ImpactAssessment = Field(default_factory=ImpactAssessment)


class ReadUpgrade(StrictModel):
    proposal_id: UUID


class ReviewUpgrade(ReadUpgrade):
    decision: Literal["accepted", "rejected", "needs_evidence"]
    basis: str = Field(min_length=1, max_length=4000)
    features: list[FeatureCorrespondence] = Field(default_factory=list, max_length=2000)
    relationships: list[RelationshipDecision] = Field(default_factory=list, max_length=2000)
    assignments: list[AssignmentDecision] = Field(default_factory=list, max_length=1000)
    impacts: Impacts = Field(default_factory=Impacts)
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)


class ReadConsumers(StrictModel):
    """Frozen consumers in the revision's workspace that pin it exactly at any depth.

    ``project_id`` is optional navigation context: that project's referenced consumers
    are listed first.
    """

    revision_id: UUID
    project_id: UUID | None = None


class ApplyUpgrade(ReadUpgrade):
    mode: Literal["new_draft", "existing_draft"]
    draft_id: UUID | None = None
    draft_expected_state: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def target(self):
        supplied = self.draft_id is not None or self.draft_expected_state is not None
        if self.mode == "new_draft" and supplied:
            raise ValueError("New draft adoption cannot name an existing draft.")
        if self.mode == "existing_draft" and (
            self.draft_id is None or self.draft_expected_state is None
        ):
            raise ValueError("Existing draft adoption requires its ID and state token.")
        return self
