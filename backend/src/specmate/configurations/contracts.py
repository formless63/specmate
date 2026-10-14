"""Option sets, selected choices and resolved configurations (CFG-001, docs/DOMAIN.md).

Three distinct records: an option set declares options and their exact choices; a
configuration draft pins one frozen option-set revision and records selections; a
resolved configuration is the immutable deterministic outcome a build consumes.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import Path, StrictModel

Key = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,79}$")]
Text = Annotated[str, Field(min_length=1, max_length=500, pattern=r"\S")]
Basis = Annotated[str, Field(min_length=1, max_length=2000, pattern=r"\S")]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]

Domain = Literal["part", "population", "firmware", "material", "process", "requirement"]
# Domains whose choices always pin an exact frozen design revision.
REVISION_DOMAINS = {"part", "population", "firmware"}
# Domains whose choice applies to one contextual occurrence of the target assembly.
OCCURRENCE_DOMAINS = {"population", "firmware"}
# Exact definition kinds required where the domain has established semantics.
DOMAIN_KINDS = {"population": "pcb_population", "firmware": "firmware"}
# Configuration records cannot be chosen as engineering content of another option.
EXCLUDED_KINDS = {"option_set", "configuration"}


class Choice(StrictModel):
    """One permitted choice: an exact frozen revision or a declared value, never both."""

    key: Key
    label: Text
    revision_id: UUID | None = None
    population_option_id: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    value: Text | None = None

    @model_validator(mode="after")
    def one_subject(self):
        if (self.revision_id is None) == (self.value is None):
            raise ValueError("A choice pins one exact revision or declares one value.")
        if self.population_option_id is not None and self.revision_id is None:
            raise ValueError("A population option belongs to an exact population revision.")
        return self


class Option(StrictModel):
    key: Key
    label: Text
    domain: Domain
    path: Path | None = None
    required: bool = True
    default_choice: Key | None = None
    choices: list[Choice] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def coherent(self):
        keys = [choice.key for choice in self.choices]
        if len(keys) != len(set(keys)):
            raise ValueError("Choice keys must be unique within an option.")
        if self.default_choice is not None and self.default_choice not in keys:
            raise ValueError("A default must name one declared choice.")
        if self.domain in REVISION_DOMAINS and any(c.revision_id is None for c in self.choices):
            raise ValueError("Part, population and firmware choices pin exact revisions.")
        if self.domain in OCCURRENCE_DOMAINS and not self.path:
            raise ValueError("Population and firmware options address one occurrence path.")
        if self.domain == "population" and any(
            c.population_option_id is None for c in self.choices
        ):
            raise ValueError("Population choices name one population option of the revision.")
        if self.domain != "population" and any(
            c.population_option_id is not None for c in self.choices
        ):
            raise ValueError("Only population choices name a population option.")
        return self


class OptionSetContent(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    target_revision_id: UUID | None = None
    options: list[Option] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def unique(self):
        keys = [option.key for option in self.options]
        if len(keys) != len(set(keys)):
            raise ValueError("Option keys must be unique.")
        addressed = [
            (option.domain, tuple(option.path))
            for option in self.options
            if option.domain in OCCURRENCE_DOMAINS
        ]
        if len(addressed) != len(set(addressed)):
            raise ValueError("Only one option may decide a domain for one occurrence.")
        if any(option.path for option in self.options) and self.target_revision_id is None:
            raise ValueError("Occurrence paths require an exact target assembly revision.")
        return self


class Selection(StrictModel):
    """`choice_key: null` deliberately leaves an optional option without a choice."""

    option_key: Key
    choice_key: Key | None


class ConfigurationContent(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    option_set_revision_id: UUID
    selections: list[Selection] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def unique(self):
        keys = [selection.option_key for selection in self.selections]
        if len(keys) != len(set(keys)):
            raise ValueError("Select each option at most once.")
        return self


class ResolveConfiguration(StrictModel):
    draft_id: UUID | None = None
    snapshot_id: UUID | None = None

    @model_validator(mode="after")
    def one_owner(self):
        if (self.draft_id is None) == (self.snapshot_id is None):
            raise ValueError("Resolve one configuration draft or one exact snapshot.")
        return self


class CaptureResolution(StrictModel):
    draft_id: UUID
    review_sha256: Sha256
    basis: Basis


class ResolvedRef(StrictModel):
    resolved_configuration_id: UUID


class ListResolved(StrictModel):
    workspace_id: UUID
