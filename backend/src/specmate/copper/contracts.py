"""Read-only, exact revision-scoped declared copper projections."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from specmate.assemblies.contracts import LocalId, Path, StrictModel
from specmate.harnesses.contracts import SegmentTerminal
from specmate.interfaces.contracts import ContactId


class EndpointTerminal(StrictModel):
    """A connector contact of one cable or harness endpoint's stack."""

    kind: Literal["endpoint"] = "endpoint"
    endpoint_id: LocalId
    contact_id: ContactId


class CableTerminal(StrictModel):
    kind: Literal["cable_conductor"] = "cable_conductor"
    endpoint_id: str
    element_path: str


class ContactTerminal(StrictModel):
    kind: Literal["contact"] = "contact"
    contact_id: str


class PadTerminal(StrictModel):
    kind: Literal["pad"] = "pad"
    pad_id: UUID
    component_id: UUID


class BoardTerminal(StrictModel):
    kind: Literal["board_terminal"] = "board_terminal"
    terminal_id: str


class BoardInternalNode(StrictModel):
    """Nonphysical junction inside one exact board occurrence; not a landing target."""

    kind: Literal["board_internal_node"] = "board_internal_node"
    node_id: str
    endpoint_id: str | None = None
    layer_id: str | None = None


class CarriedContactTerminal(StrictModel):
    """A contact of a connector body that a board declares it carries."""

    kind: Literal["carried_contact"] = "carried_contact"
    connector_id: str
    contact_id: str


class StackTerminal(StrictModel):
    """A board pad, inline part lead or shell body in one cable or harness end's stack."""

    kind: Literal["stack_terminal"] = "stack_terminal"
    endpoint_id: str
    layer_id: str
    terminal_id: str


Terminal = Annotated[
    SegmentTerminal
    | EndpointTerminal
    | CableTerminal
    | ContactTerminal
    | PadTerminal
    | BoardTerminal
    | BoardInternalNode
    | CarriedContactTerminal
    | StackTerminal,
    Field(discriminator="kind"),
]


class ReadGraph(StrictModel):
    revision_id: UUID
    occurrence_path: Path = Field(default_factory=list)
    # Optional selection is checked only after complete current source authority.
    terminal_id: str | None = Field(default=None, min_length=1, max_length=80)


class Node(StrictModel):
    id: str
    occurrence_path: Path
    revision_id: UUID
    terminal: Terminal
    label: str
    feature_kind: str
    provenance: dict


class Edge(StrictModel):
    id: str
    kind: Literal[
        "wire",
        "termination",
        "splice",
        "shield_bond",
        "through",
        "native_net",
        "board_copper",
        "join",
    ]
    evidence: Literal["declared_copper", "reported_net_membership"]
    members: list[str] = Field(min_length=2, max_length=20000)
    basis: str
    provenance: dict


class Boundary(StrictModel):
    id: str
    kind: str
    members: list[str]
    status: Literal["not_evaluated", "unknown", "declared_unconnected"]
    reason: str
    provenance: dict


class Component(StrictModel):
    id: str
    members: list[str]
    edge_ids: list[str]
    native_net_ids: list[str]
    evidence: list[Literal["declared_copper", "reported_net_membership"]]


class Graph(StrictModel):
    schema_version: Literal["1"] = "1"
    root_revision_id: UUID
    snapshot_id: UUID
    snapshot_sha256: str
    occurrence_path: Path
    nodes: list[Node]
    edges: list[Edge]
    boundaries: list[Boundary]
    components: list[Component]
    selected_component_id: str | None
    continuity: Literal["not_evaluated"] = "not_evaluated"
    compatibility: Literal["not_evaluated"] = "not_evaluated"
    physical_qualification: Literal["not_evaluated"] = "not_evaluated"
    limitations: list[str]
