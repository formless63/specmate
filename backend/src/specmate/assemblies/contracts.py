from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from specmate.contracts import FiniteNumber

LocalId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,79}$")]
FeatureId = Annotated[str, Field(min_length=1, max_length=200)]
Path = Annotated[list[LocalId], Field(max_length=32)]


def rename_keys(value, renames):
    """Return a copy of a dict with legacy keys renamed; a legacy key never overrides its new
    spelling. Anything that is not a dict, or has no legacy key, is returned unchanged."""
    if not isinstance(value, dict) or not any(old in value for old in renames):
        return value
    return {
        renames.get(key, key): item
        for key, item in value.items()
        if not (key in renames and renames[key] in value)
    }


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Placement(StrictModel):
    """A transform in the containing assembly's right-handed, z-up millimeter frame."""

    status: Literal["known", "unknown"] = "unknown"
    unit: Literal["mm"] = "mm"
    frame: Literal["right_handed_z_up"] = "right_handed_z_up"
    translation: tuple[FiniteNumber, FiniteNumber, FiniteNumber] | None = None
    rotation_xyzw: tuple[FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber] | None = None

    @model_validator(mode="after")
    def coherent(self):
        if self.status == "unknown":
            if self.translation is not None or self.rotation_xyzw is not None:
                raise ValueError("Unknown placement cannot contain guessed coordinates.")
        elif self.translation is None or self.rotation_xyzw is None:
            raise ValueError("Known placement requires translation and rotation.")
        elif abs(sum(v * v for v in self.rotation_xyzw) - 1) > 1e-6:
            raise ValueError("Rotation quaternion must have unit length.")
        return self


class Assignments(StrictModel):
    """Only occurrence-owned assignments; revision-owned geometry and wiring are excluded.

    `population_option_id` names one declared option of the occurrence's exact board
    population revision (a fitted variant chosen in this context, e.g. by adopting a
    resolved configuration); it never edits the population revision itself.
    """

    firmware_revision_id: UUID | None = None
    population_option_id: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")

    @model_serializer(mode="wrap")
    def _omit_unrecorded_option(self, handler):
        # An unrecorded option is absent, so content and manifests without one keep
        # their exact canonical bytes.
        data = handler(self)
        if data.get("population_option_id") is None:
            data.pop("population_option_id", None)
        return data


class Occurrence(StrictModel):
    local_id: LocalId
    revision_id: UUID
    display_ref: str = Field(default="", max_length=200)
    placement: Placement = Field(default_factory=Placement)
    assignments: Assignments = Field(default_factory=Assignments)


class ContextualAssignment(StrictModel):
    path: Path
    assignments: Assignments


class OccurrenceRef(StrictModel):
    kind: Literal["occurrence"] = "occurrence"
    path: Path
    feature_id: FeatureId | None = None


class RevisionRef(StrictModel):
    kind: Literal["revision"] = "revision"
    revision_id: UUID
    feature_id: FeatureId | None = None


Reference = Annotated[OccurrenceRef | RevisionRef, Field(discriminator="kind")]


class Containment(StrictModel):
    kind: Literal["containment"]
    local_id: LocalId
    parent: OccurrenceRef
    child: OccurrenceRef

    @model_validator(mode="after")
    def whole_occurrences(self):
        if self.parent.feature_id or self.child.feature_id:
            raise ValueError("Containment addresses whole occurrences.")
        return self


class Electrical(StrictModel):
    kind: Literal["electrical"]
    local_id: LocalId
    a: OccurrenceRef
    b: OccurrenceRef

    @model_validator(mode="after")
    def terminals(self):
        if not self.a.feature_id or not self.b.feature_id:
            raise ValueError("Electrical relationships require two exact feature IDs.")
        return self


class Mating(StrictModel):
    kind: Literal["mating"]
    local_id: LocalId
    a: OccurrenceRef
    b: OccurrenceRef


class Mounting(StrictModel):
    kind: Literal["mounting"]
    local_id: LocalId
    mounted: OccurrenceRef
    support: OccurrenceRef


class SourceDerivation(StrictModel):
    kind: Literal["source_derivation"]
    local_id: LocalId
    subject: OccurrenceRef
    source: RevisionRef


class Documentation(StrictModel):
    kind: Literal["documentation"]
    local_id: LocalId
    subject: Reference
    document: Reference


class Procurement(StrictModel):
    kind: Literal["procurement"]
    local_id: LocalId
    subject: OccurrenceRef
    orderable: RevisionRef


Relationship = Annotated[
    Containment | Electrical | Mating | Mounting | SourceDerivation | Documentation | Procurement,
    Field(discriminator="kind"),
]


class AssemblyContent(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    occurrences: list[Occurrence] = Field(default_factory=list, max_length=1000)
    relationships: list[Relationship] = Field(default_factory=list, max_length=2000)
    assignments: list[ContextualAssignment] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def unique_ids(self):
        for records in (self.occurrences, self.relationships):
            ids = [record.local_id for record in records]
            if len(ids) != len(set(ids)):
                raise ValueError("Local IDs must be unique within their collection.")
        paths = [tuple(record.path) for record in self.assignments]
        if len(paths) != len(set(paths)):
            raise ValueError("A contextual assignment path must be unique.")
        return self


class CreateAssembly(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    assembly: AssemblyContent = Field(default_factory=AssemblyContent)


class UpdateAssembly(StrictModel):
    draft_id: UUID
    assembly: AssemblyContent


class ReadAssembly(StrictModel):
    snapshot_id: UUID


class CaptureAssembly(StrictModel):
    draft_id: UUID


class ResolveOccurrence(ReadAssembly):
    path: Path
    feature_id: FeatureId | None = None
