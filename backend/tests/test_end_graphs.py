"""Occurrence-qualified end graphs; fixtures are independent synthetic library items."""

# ruff: noqa: F811

import copy
import json

import pytest
from pydantic import ValidationError

from specmate.design.models import Revision
from specmate.interfaces import examples
from specmate.interfaces.end_assembly_contracts import EndStack
from specmate.operations import NotFound, ValidationFailed
from specmate.preparation_documents.projection import termination_rows

from .conftest import op
from .test_cable_end_stacks import kit, make_cable, terminal  # noqa: F401
from .test_interface_ports import create, freeze


def repeated_end(kit):
    value = examples.din_adapter_end(kit["board"], kit["plug"], kit["plug_variant"])
    stack = value["stack"]
    stack["graph_version"] = "0.2"
    board = stack["layers"][0]
    board["carried_connector_layer_id"] = "connector"
    other = {**board, "layer_id": "carrier", "carried_connector_layer_id": "other-plug"}
    plug = {**stack["layers"][1], "layer_id": "other-plug"}
    stack["layers"] = [board, other, stack["layers"][1], plug]
    return value


def test_repeated_exact_revisions_are_distinct_occurrences(users, project, kit):
    end = repeated_end(kit)
    d = create(users["owner"], project, end)
    r = freeze(users["owner"], d)
    result = op(users["viewer"], "interface.read", {"revision_id": r["revision_id"]})
    view = result["end_stack"]
    assert view["connector_layer_id"] is None  # no arbitrary singleton compatibility alias
    assert view["connector_layer_ids"] == ["connector", "other-plug"]
    assert terminal(view, "board", "r")["reaches"][0]["layer_id"] == "connector"
    assert terminal(view, "carrier", "r")["reaches"][0]["layer_id"] == "other-plug"
    assert len({j["local_id"] for j in view["joins"]}) == len(view["joins"]) == 18
    assert not [
        j
        for j in view["joins"]
        if j["a"]["layer_id"] == "board" and j["b"]["layer_id"] == "other-plug"
    ]
    with pytest.raises(NotFound):
        op(users["outsider"], "interface.read", {"revision_id": r["revision_id"]})


def test_third_carrier_terminal_is_same_solder_point_in_read_and_copper(users, project, kit):
    end = repeated_end(kit)
    end["stack"]["layers"][1]["carried_connector_id"] = None
    end["stack"]["layers"][1]["carried_connector_layer_id"] = None
    end["stack"]["joins"] = [
        {
            "local_id": "carrier-solder",
            "kind": "solder",
            "basis": "Synthetic carrier drawing",
            "a": {"layer_id": "board", "terminal_id": "r"},
            "b": {"layer_id": "other-plug", "terminal_id": "4"},
            "through": {"layer_id": "carrier", "terminal_id": "r"},
        }
    ]
    e = freeze(users["owner"], create(users["owner"], project, end))["revision_id"]
    value = examples.av_demo_cable(kit["stock"], e, kit["end_b"])
    _, revision = make_cable(users["owner"], project, value)
    rid = revision["revision_id"]
    before = bytes(Revision.objects.get(id=rid).snapshot.canonical)
    read = op(users["viewer"], "cable.read", {"revision_id": rid})
    assert read["endpoints"][0]["body_revision_id"] is None
    reaches = terminal(read["endpoints"][0]["resolved_stack"], "carrier", "r")["reaches"]
    assert {(r["layer_id"], r["contact_id"]) for r in reaches} == {
        ("connector", "4"),
        ("other-plug", "4"),
    }
    rows = termination_rows(read)
    red = next(r for r in rows if r["endpoint_id"] == "a" and r["target_label"] == "R")
    assert {(c["layer_id"], c["contact_id"]) for c in red["contacts"]} == {
        ("connector", "4"),
        ("other-plug", "4"),
    }
    assert any("Same solder point carrier-solder" in note for note in red["part_notes"])
    graph = op(users["viewer"], "copper.graph", {"revision_id": rid})
    joint = next(
        e
        for e in graph["edges"]
        if e["provenance"].get("declaration", {}).get("local_id") == "carrier-solder"
    )
    assert len(joint["members"]) == 3
    nodes = {n["id"]: n for n in graph["nodes"]}
    assert {nodes[n]["terminal"]["layer_id"] for n in joint["members"]} == {
        "board",
        "carrier",
        "other-plug",
    }
    contacts = [
        n
        for n in graph["nodes"]
        if n["terminal"].get("endpoint_id") == "a" and n["terminal"].get("terminal_id") == "4"
    ]
    assert {n["terminal"]["layer_id"] for n in contacts} == {"connector", "other-plug"}
    assert len({n["id"] for n in contacts}) == 2
    assert bytes(Revision.objects.get(id=rid).snapshot.canonical) == before


def test_ambiguous_carried_connector_and_invalid_third_terminal_fail(users, kit):
    stack = repeated_end(kit)["stack"]
    del stack["layers"][0]["carried_connector_layer_id"]
    with pytest.raises(ValidationError, match="exact carried connector"):
        EndStack.model_validate(stack)
    stack = repeated_end(kit)["stack"]
    stack["layers"][0]["carried_connector_layer_id"] = "carrier"
    with pytest.raises(ValidationError, match="not a connector occurrence"):
        EndStack.model_validate(stack)
    stack = repeated_end(kit)["stack"]
    stack["joins"] = [
        {
            "local_id": "bad",
            "kind": "solder",
            "basis": "Synthetic",
            "a": {"layer_id": "board", "terminal_id": "r"},
            "b": {"layer_id": "connector", "terminal_id": "4"},
            "through": {"layer_id": "carrier", "terminal_id": "not-a-pad"},
        }
    ]
    with pytest.raises(ValidationFailed, match="terminal its layer does not have"):
        op(users["owner"], "end_assembly.resolve", {"stack": stack})


def test_legacy_end_stack_serialization_preserves_shape(kit):
    old = examples.din_adapter_end(kit["board"], kit["plug"], kit["plug_variant"])["stack"]
    parsed = EndStack.model_validate(old)
    serialized = parsed.model_dump(mode="json")
    assert "graph_version" not in serialized
    assert "carried_connector_layer_id" not in serialized["layers"][0]
    copy_stack = copy.deepcopy(serialized)
    copy_stack["layers"].append(copy_stack["layers"][0] | {"layer_id": "second"})
    with pytest.raises(ValidationError, match="at most one board"):
        EndStack.model_validate(copy_stack)
    assert json.dumps(parsed.model_dump(mode="json"), sort_keys=True) == json.dumps(
        serialized, sort_keys=True
    )


def test_versioned_local_contact_solder_bridge_preserves_legacy_and_component_guards(
    users, project, kit
):
    end = examples.din_adapter_end(kit["board"], kit["plug"], kit["plug_variant"])
    stack = end["stack"]
    stack["joins"] = [
        {
            "local_id": "local-return-bridge",
            "kind": "solder",
            "basis": "Explicit synthetic local jumper drawing",
            "a": {"layer_id": "connector", "terminal_id": "3"},
            "b": {"layer_id": "connector", "terminal_id": "7"},
        }
    ]
    with pytest.raises(ValidationError, match="Same-layer"):
        EndStack.model_validate(stack)
    stack["graph_version"] = "0.2"
    revision = freeze(users["owner"], create(users["owner"], project, end))
    view = op(users["viewer"], "interface.read", {"revision_id": revision["revision_id"]})[
        "end_stack"
    ]
    bridge = next(j for j in view["joins"] if j["local_id"] == "local-return-bridge")
    assert bridge["a"]["terminal_id"] == "3" and bridge["b"]["terminal_id"] == "7"
    invalid = copy.deepcopy(stack)
    invalid["joins"][0]["kind"] = "integrated"
    with pytest.raises(ValidationError, match="Same-layer"):
        EndStack.model_validate(invalid)


def test_two_carried_connectors_share_one_exact_board_without_invented_solder(users, project, kit):
    board = examples.av_adapter_board(kit["plug"])
    declaration = board
    declaration["terminals"].append(
        {
            "terminal_id": "second-contact",
            "label": "Second connector contact",
            "kind": "connector_contact",
        }
    )
    declaration["carried_connectors"].append(
        {
            "local_id": "second",
            "body_revision_id": kit["plug"],
            "correspondence": [{"terminal_id": "second-contact", "contact_id": "1"}],
            "review": "unreviewed",
            "basis": "Independent second physical connector drawing",
        }
    )
    board_revision = freeze(users["owner"], create(users["owner"], project, board))["revision_id"]
    first = declaration["carried_connectors"][0]["local_id"]
    stack = {
        "graph_version": "0.2",
        "layers": [
            {
                "kind": "board",
                "layer_id": "carrier",
                "board_revision_id": board_revision,
                "carried_connectors": [
                    {"carried_connector_id": first, "connector_layer_id": "plug-a"},
                    {"carried_connector_id": "second", "connector_layer_id": "plug-b"},
                ],
            },
            *[
                {
                    "kind": "connector",
                    "layer_id": id,
                    "body_revision_id": kit["plug"],
                    "pinout_revision_id": kit["plug_variant"],
                }
                for id in ["plug-a", "plug-b"]
            ],
        ],
        "joins": [],
    }
    view = op(users["viewer"], "end_assembly.resolve", {"stack": stack})
    assert len([r for r in view["layers"] if r["kind"] == "board"]) == 1
    joins = [j for j in view["joins"] if j["origin"] == "board_carried_connector"]
    second = next(j for j in joins if j["a"]["terminal_id"] == "second-contact")
    assert second["b"]["layer_id"] == "plug-b" and second["b"]["terminal_id"] == "1"
    assert second["status"] == "unknown" and second["kind"] == "carried"
    assert all(j["b"]["layer_id"] == "plug-a" for j in joins if j is not second)
    assert len({j["local_id"] for j in joins}) == len(joins)
    saved = freeze(
        users["owner"],
        create(
            users["owner"],
            project,
            {"kind": "end_assembly", "schema_version": "0.1", "stack": stack},
        ),
    )
    reopened = op(users["viewer"], "interface.read", {"revision_id": saved["revision_id"]})
    assert reopened["end_stack"]["joins"] == view["joins"]
    with pytest.raises(NotFound):
        op(users["outsider"], "interface.read", {"revision_id": saved["revision_id"]})
    invalid = copy.deepcopy(stack)
    invalid["layers"][0]["carried_connectors"][1]["carried_connector_id"] = "absent"
    with pytest.raises(ValidationFailed, match="does not declare"):
        op(users["owner"], "end_assembly.resolve", {"stack": invalid})
    invalid = copy.deepcopy(stack)
    invalid["layers"][2]["body_revision_id"] = kit["rgb_plug"]
    invalid["layers"][2]["pinout_revision_id"] = kit["rgb_variant"]
    with pytest.raises(ValidationFailed, match="exact connector body"):
        op(users["owner"], "end_assembly.resolve", {"stack": invalid})
    with pytest.raises(NotFound):
        op(users["outsider"], "end_assembly.resolve", {"stack": stack})
    for change in [{"carried_connector_id": first}, {"carried_connector_layer_id": "plug-a"}]:
        invalid = copy.deepcopy(stack)
        invalid["layers"][0].update(change)
        with pytest.raises(ValidationError, match="legacy carried"):
            EndStack.model_validate(invalid)
    invalid = copy.deepcopy(stack)
    invalid["layers"][0]["carried_connectors"][1]["connector_layer_id"] = "plug-a"
    with pytest.raises(ValidationError, match="selected once"):
        EndStack.model_validate(invalid)
    invalid = copy.deepcopy(stack)
    invalid["layers"][0]["carried_connectors"][1]["connector_layer_id"] = "carrier"
    with pytest.raises(ValidationError, match="not a connector occurrence"):
        EndStack.model_validate(invalid)
