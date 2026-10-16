"""Authored bench expectations are independent of performed physical tests."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints, model_serializer, model_validator

from specmate.assemblies.contracts import LocalId, Path, StrictModel
from specmate.cables.contracts import ElementPath
from specmate.catalog_matching.contracts import EvidenceInput
from specmate.interfaces.contracts import ContactId, Text, unique

Declaration = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class Terminal(StrictModel):
    endpoint_id: LocalId | None = None
    kind: Literal["contact", "stock_feature", "stack_terminal", "segment", "pigtail"]
    contact_id: ContactId | None = None
    element_path: ElementPath | None = None
    layer_id: LocalId | None = None
    terminal_id: str | None = Field(default=None, min_length=1, max_length=100)
    segment_id: LocalId | None = None
    pigtail_id: LocalId | None = None
    end: Literal["a", "b"] | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.kind in ("contact", "stock_feature"):
            if self.endpoint_id is None or any(
                (self.layer_id, self.terminal_id, self.segment_id, self.end, self.pigtail_id)
            ):
                raise ValueError(
                    "Legacy terminals require only an endpoint and contact or stock feature."
                )
            if self.kind == "contact":
                if self.contact_id is None or self.element_path is not None:
                    raise ValueError("Contact terminal requires only an exact contact ID.")
            elif self.element_path is None or self.contact_id is not None:
                raise ValueError("Stock terminal requires only an exact conductive feature path.")
        elif self.kind == "stack_terminal":
            if not all((self.endpoint_id, self.layer_id, self.terminal_id)) or any(
                (self.contact_id, self.element_path, self.segment_id, self.end, self.pigtail_id)
            ):
                raise ValueError("Stack terminals require exact endpoint, layer and terminal IDs.")
        elif self.kind == "pigtail":
            if not all((self.segment_id, self.end, self.pigtail_id)) or any(
                (
                    self.endpoint_id,
                    self.layer_id,
                    self.terminal_id,
                    self.contact_id,
                    self.element_path,
                )
            ):
                raise ValueError("Pigtail terminals require exact segment, end and pigtail ID.")
        elif not all((self.segment_id, self.end, self.element_path)) or any(
            (self.endpoint_id, self.layer_id, self.terminal_id, self.contact_id, self.pigtail_id)
        ):
            raise ValueError("Segment terminals require exact segment, end and conductive feature.")
        return self

    def key(self):
        if self.kind == "pigtail":
            return self.segment_id, self.kind, self.end, self.pigtail_id
        if self.kind == "stack_terminal":
            return self.endpoint_id, self.kind, self.layer_id, self.terminal_id
        if self.kind == "segment":
            return self.segment_id, self.kind, self.end, self.element_path
        return self.endpoint_id, self.kind, self.contact_id or self.element_path

    @model_serializer(mode="wrap")
    def omit_unrecorded_addresses(self, handler):
        data = handler(self)
        for field in ("layer_id", "terminal_id", "segment_id", "end", "pigtail_id"):
            if data.get(field) is None:
                data.pop(field, None)
        if self.kind in {"segment", "pigtail"}:
            data.pop("endpoint_id", None)
        return data


class DerivedFrom(StrictModel):
    """The cable intent row an expectation was proposed from; a record, never evidence."""

    intent_revision_id: UUID
    row_ids: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        min_length=1, max_length=2
    )


class PairExpectation(StrictModel):
    local_id: LocalId
    first: Terminal
    second: Terminal
    intent: Literal["continuity", "isolation", "unknown"] = "unknown"
    basis: Declaration
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)
    # What the pair carries, as named by the intent; display only, never a terminal key.
    signal: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    # A declared series resistance on the path (for example a board's sync resistor).
    expected_resistance_ohm: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None
    derived_from: DerivedFrom | None = None

    @model_validator(mode="after")
    def resistance_needs_continuity(self):
        if self.expected_resistance_ohm is not None and self.intent != "continuity":
            raise ValueError("An expected series resistance belongs to a continuity pair.")
        return self

    @model_validator(mode="after")
    def distinct(self):
        if self.first.key() == self.second.key():
            raise ValueError("A test pair requires distinct terminals.")
        return self


class Label(StrictModel):
    local_id: LocalId
    text: Annotated[str, Field(min_length=1, max_length=500)]
    endpoint_id: LocalId | None = None
    terminal: Terminal | None = None
    basis: Declaration
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def consistent(self):
        if not self.text.strip():
            raise ValueError("A label requires nonblank authored text.")
        if self.endpoint_id is not None and self.terminal is not None:
            raise ValueError("A label targets the cable, one endpoint or one terminal.")
        return self


class TestPlan(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    root_revision_id: UUID
    occurrence_path: Path = Field(default_factory=list)
    cable_revision_id: UUID
    pairs: list[PairExpectation] = Field(default_factory=list, max_length=2048)
    labels: list[Label] = Field(default_factory=list, max_length=2048)

    @model_validator(mode="after")
    def unique_ids(self):
        unique([p.local_id for p in self.pairs])
        unique([tuple(sorted([p.first.key(), p.second.key()])) for p in self.pairs])
        unique([label.local_id for label in self.labels])
        return self


class CreatePlan(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
    name: Text
    test_plan: TestPlan


class UpdatePlan(StrictModel):
    draft_id: UUID
    test_plan: TestPlan


class CapturePlan(StrictModel):
    draft_id: UUID


class ReadPlan(StrictModel):
    revision_id: UUID


class DeriveFromIntent(StrictModel):
    """Propose expectations for an exact frozen cable from its pinned (or a named) intent."""

    root_revision_id: UUID
    occurrence_path: Path = Field(default_factory=list)
    cable_revision_id: UUID
    intent_revision_id: UUID | None = None


class InspectTarget(StrictModel):
    root_revision_id: UUID
    occurrence_path: Path = Field(default_factory=list)
    cable_revision_id: UUID
