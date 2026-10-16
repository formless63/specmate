"""End stacks: what sits at one cable end, ordered from the wire outward.

A stack is a short list of layers: an optional board (PCBA) whose labeled pads the wire
lands on, optional hand-soldered inline parts (for example a series resistor), the
connector body with its chosen pinout variant, and an optional shell or hood. Joins say
how terminals of two layers are connected. Nothing is joined by label equality:

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
    """A declared connection between terminals of two different layers."""

    local_id: Key
    a: StackTerminal
    b: StackTerminal
    kind: Literal["solder", "crimp", "mated", "integrated", "bond"]
    basis: Basis

    @model_validator(mode="after")
    def distinct_layers(self):
        if self.a.layer_id == self.b.layer_id:
            raise ValueError("A join connects terminals of two different layers.")
        return self


class EndStack(StrictModel):
    # Ordered from the wire outward; a shell, when present, is the outermost layer.
    layers: list[Layer] = Field(min_length=1, max_length=8)
    joins: list[Join] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def consistent(self):
        ids = [layer.layer_id for layer in self.layers]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate layer ID.")
        kinds = [layer.kind for layer in self.layers]
        for kind in ("connector", "board", "inline", "shell"):
            if kinds.count(kind) > 1:
                raise ValueError(f"A stack has at most one {kind} layer.")
        if "shell" in kinds and kinds[-1] != "shell":
            raise ValueError("The shell is the outermost layer of a stack.")
        layers = {layer.layer_id: layer for layer in self.layers}
        board = next((layer for layer in self.layers if layer.kind == "board"), None)
        if board and board.carried_connector_id and "connector" not in kinds:
            raise ValueError("A carried connector needs the stack's connector layer.")
        joins = [j.local_id for j in self.joins]
        if len(joins) != len(set(joins)):
            raise ValueError("Duplicate join ID.")
        for join in self.joins:
            ends = (join.a, join.b)
            for end in ends:
                if end.layer_id not in layers:
                    raise ValueError("A join names an undeclared layer.")
            shell = [e for e in ends if layers[e.layer_id].kind == "shell"]
            if join.kind == "bond" and not shell:
                raise ValueError("A bond join connects a terminal to the shell.")
            if shell and join.kind != "bond":
                raise ValueError("A shell is joined electrically only by a declared bond.")
        return self


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
