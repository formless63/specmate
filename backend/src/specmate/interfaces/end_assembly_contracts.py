"""End stacks: what sits at one cable end, ordered from the wire outward.

A stack is a short list of layers: an optional board (PCBA) whose labeled pads the wire
lands on, optional hand-soldered inline parts (for example a series resistor), the
connector body with its chosen pinout variant, and an optional shell or hood. Joins say
how terminals of different layers or distinct inline parts are connected. Nothing is
joined by label equality:

- a board's reviewed carried-connector correspondence joins its pads to the connector
  layer when the board layer names that carried connector; an unreviewed one stays unknown;
- every other join is declared explicitly with a basis;
- a shell is mechanical: it has one terminal (its body) and creates no electrical relation
  unless a ``bond`` join or a termination names it.

An ``end_assembly`` is a reusable library item holding one stack. A cable end either pins
an end assembly revision or carries an ad-hoc stack of the same shape.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_serializer, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.interfaces.board_contracts import InlineComponent, Key

Text = Annotated[str, Field(min_length=1, max_length=200)]
Basis = Annotated[str, Field(min_length=1, max_length=2000)]
# A layer terminal: a board terminal ID, a connector contact ID, "<part>.1"/"<part>.2" on an
# inline layer, or "body" on a shell layer.
StackTerminalId = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S+$")]
SHELL_BODY = "body"
INLINE_PINS = ("1", "2")


class ConnectorLayer(StrictModel):
    kind: Literal["connector"] = "connector"
    layer_id: LocalId
    body_revision_id: UUID
    # The chosen pinout variant of that exact body revision.
    pinout_revision_id: UUID


class BoardLayer(StrictModel):
    kind: Literal["board"] = "board"
    layer_id: LocalId
    board_revision_id: UUID
    # The board's carried connector that is this stack's connector layer, when it is.
    carried_connector_id: Key | None = None
    # Required when an end graph contains more than one connector occurrence.
    carried_connector_layer_id: LocalId | None = None

    # Runtime/configuration declaration for this exact board occurrence; absent is unknown.
    condition_states: dict[Key, Key] = Field(default_factory=dict, max_length=20)

    @model_serializer(mode="wrap")
    def omit_unrecorded_target(self, handler):
        data = handler(self)
        if not data.get("condition_states"):
            data.pop("condition_states", None)
        if data.get("carried_connector_layer_id") is None:
            data.pop("carried_connector_layer_id", None)
        return data


class InlinePart(StrictModel):
    """An explicitly declared two-lead use, ``<local_id>.1`` and ``<local_id>.2``.

    An optional catalog pin records provenance. It never establishes the package's
    terminal count, pinout, electrical behavior, fit or compatibility.
    """

    local_id: Key
    component: InlineComponent
    label: Text | None = None
    part_revision_id: UUID | None = None

    @model_serializer(mode="wrap")
    def omit_unrecorded_part(self, handler):
        data = handler(self)
        if data.get("part_revision_id") is None:
            data.pop("part_revision_id", None)
        return data


class InlineLayer(StrictModel):
    kind: Literal["inline"] = "inline"
    layer_id: LocalId
    parts: list[InlinePart] = Field(min_length=1, max_length=20)


class ShellLayer(StrictModel):
    kind: Literal["shell"] = "shell"
    layer_id: LocalId
    # The shell or hood part; unknown when not yet chosen.
    part_revision_id: UUID | None = None
    label: Text | None = None


Layer = Annotated[
    ConnectorLayer | BoardLayer | InlineLayer | ShellLayer, Field(discriminator="kind")
]


class StackTerminal(StrictModel):
    layer_id: LocalId
    terminal_id: StackTerminalId


class Join(StrictModel):
    """A declared connection between layers or distinct inline parts."""

    local_id: Key
    a: StackTerminal
    b: StackTerminal
    # A third terminal at the SAME solder point, e.g. a carrier-board hole.
    # This is not an electrical component or a separate material segment.
    through: StackTerminal | None = None
    kind: Literal["solder", "crimp", "mated", "integrated", "bond"]
    basis: Basis

    @model_validator(mode="after")
    def distinct_terminals(self):
        members = [self.a, self.b, *([self.through] if self.through else [])]
        if len({(m.layer_id, m.terminal_id) for m in members}) != len(members):
            raise ValueError("A join requires different terminals.")
        if self.through is not None and self.kind != "solder":
            raise ValueError("A third carrier terminal requires a solder join.")
        return self

    @model_serializer(mode="wrap")
    def omit_unrecorded_carrier(self, handler):
        data = handler(self)
        if data.get("through") is None:
            data.pop("through", None)
        return data


class EndStack(StrictModel):
    # Legacy stacks are ordered wire-outward. Version 0.2 is an occurrence graph;
    # ordering is presentation only and never implies electrical/mechanical attachment.
    graph_version: Literal["0.1", "0.2"] = "0.1"
    layers: list[Layer] = Field(min_length=1, max_length=64)
    joins: list[Join] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def consistent(self):
        ids = [layer.layer_id for layer in self.layers]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate layer ID.")
        kinds = [layer.kind for layer in self.layers]
        if self.graph_version == "0.1":
            if len(self.layers) > 8:
                raise ValueError("A legacy stack has at most eight layers.")
            for kind in ("connector", "board", "inline", "shell"):
                if kinds.count(kind) > 1:
                    raise ValueError(f"A stack has at most one {kind} layer.")
        if self.graph_version == "0.1" and "shell" in kinds and kinds[-1] != "shell":
            raise ValueError("The shell is the outermost layer of a stack.")
        layers = {layer.layer_id: layer for layer in self.layers}
        connectors = [layer for layer in self.layers if layer.kind == "connector"]
        for board in (layer for layer in self.layers if layer.kind == "board"):
            if board.carried_connector_layer_id and not board.carried_connector_id:
                raise ValueError("A connector occurrence target requires a carried connector.")
            if board.carried_connector_id:
                if not connectors:
                    raise ValueError("A carried connector needs the stack's connector layer.")
                if len(connectors) > 1 and not board.carried_connector_layer_id:
                    raise ValueError("Choose the exact carried connector layer occurrence.")
                if board.carried_connector_layer_id and not any(
                    c.layer_id == board.carried_connector_layer_id for c in connectors
                ):
                    raise ValueError("The carried connector layer is not a connector occurrence.")
        joins = [j.local_id for j in self.joins]
        if len(joins) != len(set(joins)):
            raise ValueError("Duplicate join ID.")
        for join in self.joins:
            ends = (join.a, join.b, *([join.through] if join.through else []))
            if join.through and self.graph_version != "0.2":
                raise ValueError("A third solder terminal requires end graph version 0.2.")
            for end in ends:
                if end.layer_id not in layers:
                    raise ValueError("A join names an undeclared layer.")
            if join.through and layers[join.through.layer_id].kind != "board":
                raise ValueError("A carrier solder terminal belongs to a board occurrence.")
            if join.a.layer_id == join.b.layer_id:
                layer = layers[join.a.layer_id]
                if layer.kind != "inline" and not (
                    self.graph_version == "0.2"
                    and join.kind == "solder"
                    and layer.kind in {"board", "connector"}
                ):
                    raise ValueError("Same-layer joins require distinct declared inline parts.")
                if layer.kind != "inline":
                    continue
                owners = {
                    f"{part.local_id}.{lead}": part.local_id
                    for part in layer.parts
                    for lead in INLINE_PINS
                }
                a, b = owners.get(join.a.terminal_id), owners.get(join.b.terminal_id)
                if a is None or b is None or a == b:
                    raise ValueError("An inline join requires declared leads of different parts.")
            shell = [e for e in ends if layers[e.layer_id].kind == "shell"]
            if join.kind == "bond" and not shell:
                raise ValueError("A bond join connects a terminal to the shell.")
            if shell and join.kind != "bond":
                raise ValueError("A shell is joined electrically only by a declared bond.")
        return self

    @model_serializer(mode="wrap")
    def omit_legacy_version(self, handler):
        data = handler(self)
        if self.graph_version == "0.1":
            data.pop("graph_version", None)
        return data


class EndAssembly(StrictModel):
    """A reusable cable end: the stack without the wire, pinned by cable ends."""

    kind: Literal["end_assembly"] = "end_assembly"
    schema_version: Literal["0.1"] = "0.1"
    description: Text | None = None
    stack: EndStack
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def reviewed(self):
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed end assemblies require a review basis.")
        return self


class ResolveEnd(StrictModel):
    """Resolve one end's layers and terminals by label: a stack or an end assembly revision."""

    stack: EndStack | None = None
    end_assembly_revision_id: UUID | None = None

    @model_validator(mode="after")
    def one(self):
        if (self.stack is None) == (self.end_assembly_revision_id is None):
            raise ValueError("Resolve either a stack or an end assembly revision.")
        return self
