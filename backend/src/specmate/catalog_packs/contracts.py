from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

ExactText = Annotated[str, StringConstraints(strip_whitespace=False)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class FilePin(Contract):
    source_bundle_revision_id: UUID
    source_path: ExactText = Field(min_length=1, max_length=512)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    rights: ExactText = Field(min_length=1, max_length=200)


class RecipeReference(Contract):
    recipe_id: str = Field(min_length=1, max_length=100)
    version: str = Field(min_length=1, max_length=100)
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class PackEntry(Contract):
    key: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,79}$")
    label: ExactText = Field(min_length=1, max_length=200)
    category: Literal["content", "rule", "profile", "model", "recipe_reference"]
    revision_id: UUID | None = None
    revision_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    source: FilePin | None = None
    recipe: RecipeReference | None = None
    rights: ExactText = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def inert_shape(self) -> Self:
        if (self.revision_id is None) != (self.revision_sha256 is None):
            raise ValueError("Engineering entries require an exact revision and snapshot hash.")
        if self.category == "recipe_reference":
            if self.recipe is None or self.revision_id is not None:
                raise ValueError(
                    "A recipe reference requires inert recipe identity, not design code."
                )
        elif self.recipe is not None:
            raise ValueError("Only a recipe reference can carry recipe metadata.")
        if self.category in {"content", "profile"} and self.revision_id is None:
            raise ValueError("Content and profile entries require exact engineering revisions.")
        if self.category in {"rule", "model"} and self.source is None:
            raise ValueError("Rule and model entries require exact registered source files.")
        return self


class SignatureClaim(Contract):
    algorithm: str = Field(min_length=1, max_length=100)
    signer: str = Field(min_length=1, max_length=200)
    signature: ExactText = Field(min_length=1, max_length=4000)


class PackManifest(Contract):
    format: Literal["specmate.catalog-pack"] = "specmate.catalog-pack"
    contract_version: str = Field(default="1", min_length=1, max_length=100)
    package_key: str = Field(pattern=r"^[a-z][a-z0-9_.-]{0,99}$")
    label: ExactText = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=100)
    publisher: ExactText = Field(min_length=1, max_length=200)
    rights: ExactText = Field(min_length=1, max_length=200)
    capabilities: list[str] = Field(default_factory=list, max_length=50)
    requested_authority: list[str] = Field(default_factory=list, max_length=0)
    dependencies: list[UUID] = Field(default_factory=list, max_length=50)
    signature_claim: SignatureClaim | None = None
    entries: list[PackEntry] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_members(self) -> Self:
        if len({entry.key for entry in self.entries}) != len(self.entries):
            raise ValueError("Pack entry keys must be unique.")
        if len(set(self.dependencies)) != len(self.dependencies):
            raise ValueError("Pack dependencies must be unique exact versions.")
        if any(not capability.strip() or len(capability) > 100 for capability in self.capabilities):
            raise ValueError("Capability claims must be bounded nonempty labels.")
        return self


class RegisterPackVersion(Contract):
    # Omitted: the actor's workspace. A pack installs into the workspace library.
    workspace_id: UUID | None = None
    pack_id: UUID | None = None
    manifest: PackManifest
    manifest_source: FilePin | None = None


class InstallPack(Contract):
    pack_id: UUID
    version_id: UUID
    basis: str = Field(min_length=1, max_length=4000)


class DisablePack(Contract):
    pack_id: UUID
    basis: str = Field(min_length=1, max_length=4000)


class AdoptPack(Contract):
    pack_id: UUID
    version_id: UUID
    entry_keys: list[str] = Field(min_length=1, max_length=100)
    basis: str = Field(min_length=1, max_length=4000)

    @model_validator(mode="after")
    def unique_selection(self) -> Self:
        if len(set(self.entry_keys)) != len(self.entry_keys):
            raise ValueError("Entry selection must be unique.")
        return self


class EngineeringPin(Contract):
    definition_id: UUID
    revision_id: UUID
    name: ExactText
    kind: str
    number: int
    sha256: str


class EntryResult(PackEntry):
    engineering: EngineeringPin | None
    interpretation: Literal["draft_copy_available", "inert_unparsed_not_executed"]


class VersionResult(Contract):
    version_id: UUID
    pack_id: UUID
    sha256: str
    manifest: PackManifest
    manifest_source: FilePin | None
    signature_status: Literal["unsigned", "unverified_claim"]
    publisher_status: Literal["unverified_claim"]
    compatibility: Literal["supported_contract", "unsupported_contract"]
    execution_authority: Literal["none"]
    registered_by_id: int
    registered_at: str
    entries: list[EntryResult]


class VersionSummary(Contract):
    version_id: UUID
    version: str
    label: ExactText
    sha256: str


class PackResult(Contract):
    pack_id: UUID
    workspace_id: UUID
    package_key: str
    state: str
    installed_version_id: UUID | None
    enabled: bool
    versions: list[VersionSummary]
    execution_authority: Literal["none"]
    consumer_adoption: Literal["explicit_new_drafts_only"]
