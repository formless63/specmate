from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

AssociationKind = Literal["import", "supplier", "model"]
ReviewDecision = Literal["accepted", "rejected", "needs_evidence"]
ExactText = Annotated[str, StringConstraints(strip_whitespace=False)]


class EvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    status: Literal["unknown", "unverified_citation", "registered_file"] = "unknown"
    citation: ExactText | None = Field(default=None, min_length=1, max_length=4000)
    source_bundle_revision_id: UUID | None = None
    source_path: ExactText | None = Field(default=None, min_length=1, max_length=512)

    @model_validator(mode="after")
    def consistent(self) -> Self:
        registered = self.source_bundle_revision_id is not None and self.source_path is not None
        if self.status == "registered_file":
            if not registered or self.citation is not None:
                raise ValueError("Registered evidence requires an exact bundle revision and path.")
        elif self.source_bundle_revision_id is not None or self.source_path is not None:
            raise ValueError("Only registered evidence can name a source file.")
        elif self.status == "unverified_citation":
            if self.citation is None or not self.citation.strip():
                raise ValueError("An unverified citation requires citation text.")
        elif self.citation is not None:
            raise ValueError("Unknown evidence cannot claim a citation.")
        return self


class ProposeMatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    source_revision_id: UUID
    target_revision_id: UUID
    association_kind: AssociationKind
    observed_source_identifier: str = Field(min_length=1, max_length=200)
    observed_target_identifier: str = Field(min_length=1, max_length=200)
    basis: str = Field(min_length=1, max_length=4000)
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)


class ReviewMatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    candidate_id: UUID
    decision: ReviewDecision
    basis: str = Field(min_length=1, max_length=4000)
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)


class EvidenceResult(BaseModel):
    status: Literal["unknown", "unverified_citation", "registered_file"]
    citation: str | None = None
    source_bundle_revision_id: UUID | None = None
    source_path: str | None = None
    sha256: str | None = None
    rights: str | None = None
    media_type: str | None = None


class RevisionIdentity(BaseModel):
    revision_id: UUID
    definition_id: UUID
    workspace_id: UUID
    name: str
    kind: str
    number: int
    sha256: str


class SuggestSupplierMatches(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_revision_id: UUID
    source_variant_id: UUID
    after: UUID | None = None
    limit: int = 25


class SupplierSuggestion(BaseModel):
    source_variant_id: UUID
    target_variant_id: UUID
    manufacturer: str
    part_number: str
    source_association_basis: str
    target_association_basis: str
    target: RevisionIdentity
    match_basis: Literal["exact_manufacturer_and_part_number"]
    review: Literal["not_reviewed"] = "not_reviewed"
    compatibility: Literal["not_evaluated"] = "not_evaluated"


class SupplierSuggestions(BaseModel):
    source: RevisionIdentity
    workspace_id: UUID
    results: list[SupplierSuggestion]
    next_after: UUID | None
    inspection_truncated: bool
    meaning: Literal["identifier_suggestions_only"] = "identifier_suggestions_only"


class ReviewResult(BaseModel):
    review_id: UUID
    version: int
    decision: ReviewDecision
    basis: str
    evidence: EvidenceResult
    reviewed_at: str
    reviewed_by_id: int


class CandidateResult(BaseModel):
    candidate_id: UUID
    source: RevisionIdentity
    target: RevisionIdentity
    association_kind: AssociationKind
    observed_source_identifier: str
    observed_target_identifier: str
    basis: str
    evidence: EvidenceResult
    state: str
    decision: Literal["unreviewed", "accepted", "rejected", "needs_evidence"]
    meaning: Literal["reviewed_correspondence_only"] = "reviewed_correspondence_only"
    created_at: str
    proposed_by_id: int
    reviews: list[ReviewResult]
