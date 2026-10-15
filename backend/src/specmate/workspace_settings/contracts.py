"""Workspace presentation and numbering intent; neither grants engineering authority."""

import re
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import Field, StringConstraints, field_validator, model_validator

from specmate.assemblies.contracts import StrictModel

Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Kind = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,79}$")]


class DocumentTitleBlock(StrictModel):
    organization: Text | None = None
    rights_line: Text | None = None
    designer: Text | None = None
    label_qr_url: Text | None = None
    paper: Literal["A4", "A3", "letter", "legal"] | None = None
    title_block: Literal["iso7200", "ansi"] | None = None

    @field_validator("label_qr_url")
    @classmethod
    def safe_url(cls, value):
        if value and (
            urlsplit(value).scheme not in {"http", "https"} or not urlsplit(value).netloc
        ):
            raise ValueError("Label QR address must be an HTTP or HTTPS address.")
        return value


class DocumentSettingsSnapshot(DocumentTitleBlock):
    # Values are explicitly reviewed copies, including any edited defaults. This is
    # provenance, not a lookup key or an authorization assertion.
    source_settings_version: int = Field(ge=0, strict=True)


class PrefixScheme(StrictModel):
    id: Text | None = None
    label: Text | None = None
    prefixes: dict[Kind, Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{1,8}$")]]
    digits: int = Field(default=5, ge=1, le=12, strict=True)
    separator: str = Field(default="-", max_length=2)
    allowRevisionSuffix: bool = False
    src: Text | None = None

    @field_validator("prefixes")
    @classmethod
    def bounded(cls, value):
        if not 1 <= len(value) <= 100:
            raise ValueError("Declare between one and 100 kind prefixes.")
        return value


class Span(StrictModel):
    from_: int = Field(alias="from", ge=0, le=999_999_999_999, strict=True)
    to: int = Field(ge=0, le=999_999_999_999, strict=True)

    @model_validator(mode="after")
    def ordered(self):
        if self.to < self.from_:
            raise ValueError("Range end precedes its start.")
        return self


BoundedCounter = Annotated[int, Field(ge=0, le=999_999_999_999, strict=True)]


class CounterRange(StrictModel):
    match: dict[str, str | list[str]] | list[dict[str, str | list[str]]] | None = None
    from_: BoundedCounter | None = Field(default=None, alias="from")
    to: BoundedCounter | None = None
    spans: list[Span] | None = Field(default=None, max_length=100)
    exclude: list[BoundedCounter | Span] | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def bounded_ranges(self):
        if self.spans is not None:
            if not self.spans or self.from_ is not None or self.to is not None:
                raise ValueError("Use nonempty spans or a from/to range.")
        elif self.from_ is None or self.to is None or self.to < self.from_:
            raise ValueError("A range needs ordered from/to bounds.")
        alternatives = self.match if isinstance(self.match, list) else [self.match]
        if len(alternatives) > 50:
            raise ValueError("At most 50 range alternatives.")
        for match in alternatives:
            if match is not None and len(match) > 12:
                raise ValueError("At most 12 matched segments.")
            for selected in (match or {}).values():
                values = selected if isinstance(selected, list) else [selected]
                if not values or len(values) > 200:
                    raise ValueError("Range matches need bounded choice values.")
                if any(not re.fullmatch(r"[A-Za-z0-9]{1,8}", value) for value in values):
                    raise ValueError("Range matches name choice values.")
        return self


class ChoiceValue(StrictModel):
    value: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9]{1,8}$")]
    label: Text | None = None
    kinds: list[Kind] | None = Field(default=None, max_length=100)


class Segment(StrictModel):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
    label: Text | None = None


class ChoiceSegment(Segment):
    type: Literal["choice"]
    values: list[ChoiceValue] = Field(min_length=1, max_length=200)
    default: str | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def distinct_values(self):
        values = [choice.value.casefold() for choice in self.values]
        if len(values) != len(set(values)):
            raise ValueError("Choice values must be distinct.")
        if self.default is not None and self.default.casefold() not in values:
            raise ValueError("The default must be a declared choice.")
        return self


class CounterSegment(Segment):
    type: Literal["counter"]
    width: int = Field(ge=1, le=12, strict=True)
    per: list[str] | None = Field(default=None, max_length=12)
    ranges: list[CounterRange] | None = Field(default=None, max_length=100)
    exclude: list[BoundedCounter | Span] | None = Field(default=None, max_length=100)


class VariantSegment(Segment):
    type: Literal["variant"]
    style: Literal["numeric", "alpha"]
    width: int = Field(ge=1, le=12, strict=True)
    first: str | None = Field(default=None, max_length=12)
    max: str | None = Field(default=None, max_length=12)
    optional: bool = False
    kinds: list[Kind] | None = Field(default=None, max_length=100)


class SchemeValidation(StrictModel):
    # Arbitrary expressions are deliberately unsupported. Segment parsing is bounded.
    regex: None = None
    message: Text | None = None


class DeclarativeScheme(StrictModel):
    type: Literal["declarative"]
    id: Text | None = None
    label: Text | None = None
    template: str = Field(min_length=1, max_length=200)
    segments: list[
        Annotated[ChoiceSegment | CounterSegment | VariantSegment, Field(discriminator="type")]
    ] = Field(min_length=1, max_length=12)
    validation: SchemeValidation | None = None
    immutable: bool = True
    src: Text | None = None

    @model_validator(mode="after")
    def references(self):
        ids = [segment.id for segment in self.segments]
        fields = re.findall(r"\{([a-z0-9_]+)\}", self.template)
        if len(ids) != len(set(ids)) or len(fields) != len(ids) or set(fields) != set(ids):
            raise ValueError("Template must name each distinct declared segment.")
        if sum(segment.type == "counter" for segment in self.segments) != 1:
            raise ValueError("Declare exactly one sequence counter.")
        return self


class WorkspaceSettings(StrictModel):
    documents: DocumentTitleBlock = Field(default_factory=DocumentTitleBlock)
    numbering: PrefixScheme | DeclarativeScheme | None = None


class SettingsRef(StrictModel):
    workspace_id: UUID


class UpdateSettings(SettingsRef):
    values: WorkspaceSettings
