"""PCB-006: ordered internal passages must not manufacture external pads."""

import copy

import pytest
from pydantic import ValidationError

from specmate.interfaces.board_contracts import Board
from specmate.interfaces.boards import board_model
from specmate.interfaces.queries import inspect_revision
from specmate.operations import NotFound

from .conftest import op
from .test_interface_boards import trace
from .test_interface_ports import frozen


def chain():
    return {
        "interface": {
            "kind": "board",
            "schema_version": "0.2",
            "terminals": [
                {"terminal_id": "in", "label": "Input"},
                {"terminal_id": "out", "label": "Output"},
            ],
            "internal_nodes": [
                {
                    "node_id": "junction",
                    "label": "Between C and R",
                    "basis": "Declared series order; not an external pad",
                }
            ],
            "paths": [
                {
                    "local_id": "capacitor",
                    "from_terminal": "in",
                    "to_terminal": "junction",
                    "via": "component",
                    "component": {
                        "kind": "capacitor",
                        "value": "100 nF",
                        "capacitance_f": "0.0000001",
                    },
                    "basis": "Declared C1",
                },
                {
                    "local_id": "resistor",
                    "from_terminal": "junction",
                    "to_terminal": "out",
                    "via": "component",
                    "component": {"kind": "resistor", "value": "2k2", "resistance_ohm": "2200"},
                    "basis": "Declared R1",
                },
            ],
        }
    }


def test_internal_nodes_require_version_and_cannot_be_physical_correspondence():
    data = chain()["interface"]
    assert len(board_model(Board.model_validate(data))[0]["nodes"]) == 3
    old = copy.deepcopy(data)
    old["schema_version"] = "0.1"
    with pytest.raises(ValidationError, match=r"require board schema 0\.2"):
        Board.model_validate(old)
    duplicate = copy.deepcopy(data)
    duplicate["internal_nodes"][0]["node_id"] = "in"
    with pytest.raises(ValidationError, match="distinct identities"):
        Board.model_validate(duplicate)
    carried = copy.deepcopy(data)
    carried["carried_connectors"] = [
        {
            "local_id": "plug",
            "body_revision_id": "00000000-0000-0000-0000-000000000001",
            "correspondence": [{"terminal_id": "junction", "contact_id": "1"}],
        }
    ]
    with pytest.raises(ValidationError, match="undeclared terminal"):
        Board.model_validate(carried)


def test_series_model_retains_every_element_and_active_boundary():
    data = chain()["interface"]
    board = Board.model_validate(data)
    _, model = board_model(board)
    assert [p["kind"] for p in model["passages"]] == ["capacitor", "resistor"]
    data["paths"][1]["component"] = {"kind": "active", "reference": "U1"}
    _, model = board_model(Board.model_validate(data))
    assert model["passages"][1]["kind"] == "active"


def test_frozen_chain_inspection_trace_and_copper_keep_nodes_nonphysical(users, project):
    revision = frozen(users["owner"], project, chain()["interface"], "Synthetic series board")
    view = inspect_revision(users["viewer"], revision)["board"]
    assert len(view["terminals"]) == 2
    assert view["paths"][0]["to_label"] == "Between C and R"
    result = trace(users["viewer"], revision, "in", "out")
    assert result["status"] == "modeled_blocked"
    assert result["paths"][0]["terminal_labels"] == [
        "Input",
        "Internal graph node: Between C and R",
        "Output",
    ]
    with pytest.raises(NotFound):
        trace(users["viewer"], revision, "junction", "out")
    graph = op(users["viewer"], "copper.graph", {"revision_id": revision})
    internal = [n for n in graph["nodes"] if n["terminal"]["kind"] == "board_internal_node"]
    assert len(internal) == 1 and internal[0]["feature_kind"] == "internal_graph_node"


def test_end_stack_preserves_internal_chain_but_rejects_internal_joint_landing(users, project):
    from specmate.operations import ValidationFailed

    revision = frozen(users["owner"], project, chain()["interface"], "Synthetic internal graph")
    stack = {
        "graph_version": "0.2",
        "layers": [
            {"kind": "board", "layer_id": "one", "board_revision_id": revision},
            {"kind": "board", "layer_id": "two", "board_revision_id": revision},
        ],
        "joins": [],
    }
    resolved = op(users["viewer"], "end_assembly.resolve", {"stack": stack})
    layer = resolved["layers"][0]
    assert [n["node_id"] for n in layer["internal_nodes"]] == ["junction"]
    assert {t["terminal_id"] for t in layer["terminals"]} == {"in", "out"}
    stack["joins"] = [
        {
            "local_id": "invalid",
            "kind": "solder",
            "basis": "Must not invent a solder pad",
            "a": {"layer_id": "one", "terminal_id": "junction"},
            "b": {"layer_id": "two", "terminal_id": "out"},
        }
    ]
    with pytest.raises(ValidationFailed):
        op(users["owner"], "end_assembly.resolve", {"stack": stack})
