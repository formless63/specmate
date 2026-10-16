"""Declared series joints preserve exact leads, unknown models and full authority."""

import json
from uuid import UUID

import pytest
from pydantic import ValidationError

from specmate.cables.intent_check import Graph
from specmate.cables.queries import Closure
from specmate.design.models import Revision
from specmate.interfaces import examples
from specmate.interfaces.end_assembly_contracts import EndStack
from specmate.operations import NotFound

from .conftest import op
from .test_cable_end_stacks import kit as kit
from .test_cable_end_stacks import layer, make_cable
from .test_harnesses import capture as freeze_harness
from .test_harnesses import create as create_harness
from .test_inline_part_pins import catalog_part
from .test_interface_ports import create, freeze


def declaration():
    return {
        "layers": [
            {
                "kind": "inline",
                "layer_id": "inline",
                "parts": [
                    {"local_id": "r1", "component": {"kind": "resistor"}},
                    {"local_id": "u2", "component": {"kind": "unknown"}},
                ],
            }
        ],
        "joins": [
            {
                "local_id": "series",
                "a": {"layer_id": "inline", "terminal_id": "r1.2"},
                "b": {"layer_id": "inline", "terminal_id": "u2.1"},
                "kind": "solder",
                "basis": "Explicit series lead declaration",
            }
        ],
    }


@pytest.mark.parametrize("target", ["r1.1", "r1.2", "u2.3", "missing.1"])
def test_same_part_bypass_self_join_and_undeclared_leads_are_rejected(target):
    value = declaration()
    value["joins"][0]["b"]["terminal_id"] = target
    with pytest.raises(ValidationError):
        EndStack.model_validate(value)


@pytest.mark.parametrize("kind", ["board", "shell"])
def test_other_same_layer_joins_remain_rejected(kind):
    value = declaration()
    value["layers"] = [
        {"kind": "board", "layer_id": "same", "board_revision_id": UUID(int=1)}
        if kind == "board"
        else {"kind": "shell", "layer_id": "same"}
    ]
    value["joins"][0].update(
        a={"layer_id": "same", "terminal_id": "a"}, b={"layer_id": "same", "terminal_id": "b"}
    )
    with pytest.raises(ValidationError):
        EndStack.model_validate(value)


def test_inline_bond_still_requires_shell_and_legacy_shape_is_literal():
    value = declaration()
    value["joins"][0]["kind"] = "bond"
    with pytest.raises(ValidationError, match="shell"):
        EndStack.model_validate(value)
    literal = {
        "layers": [{"kind": "shell", "layer_id": "shell", "part_revision_id": None, "label": None}],
        "joins": [],
    }
    assert EndStack.model_validate(literal).model_dump(mode="json") == literal


def series(users, project, kit):
    owner = users["owner"]
    _, first = catalog_part(owner, project)
    _, second = catalog_part(owner, project)
    value = examples.rgb_inline_end(kit["rgb_plug"], kit["rgb_variant"], kit["hood"])
    inline = value["stack"]["layers"][0]
    inline["parts"][0]["part_revision_id"] = first["revision_id"]
    inline["parts"].append(
        {
            "local_id": "u2",
            "part_revision_id": second["revision_id"],
            "component": {"kind": "unknown"},
        }
    )
    for join in value["stack"]["joins"]:
        if join["a"] == {"layer_id": "inline", "terminal_id": "r1.2"}:
            join["a"]["terminal_id"] = "u2.2"
    value["stack"]["joins"].append(declaration()["joins"][0])
    end = freeze(owner, create(owner, project, value))
    cable = examples.av_demo_cable(kit["stock"], kit["end_a"], end["revision_id"])
    _, frozen = make_cable(owner, project, cable)
    harness = freeze_harness(
        owner,
        create_harness(
            owner,
            project,
            {
                "schema_version": "0.2",
                "endpoints": [{"local_id": "joined", "stack": value["stack"]}],
            },
        ),
    )
    return value, end, cable, frozen, harness, second


def test_series_path_provenance_cable_harness_and_retained_bytes(users, project, kit):
    original = bytes(Revision.objects.get(id=kit["end_b"]).snapshot.canonical)
    value, end, cable, frozen, harness, second = series(users, project, kit)
    view = op(users["viewer"], "interface.read", {"revision_id": end["revision_id"]})["end_stack"]
    joint = next(row for row in view["joins"] if row["local_id"] == "series")
    assert joint["basis"] == "Explicit series lead declaration"
    assert joint["origin"] == joint["status"] == "declared"
    assert view["continuity"] == "not_evaluated"
    assert layer(view, "inline")["parts"][1]["component"]["kind"] == "unknown"
    graph = Graph(Closure(users["viewer"], {"cable": cable}, "cable"))
    paths, _ = graph.paths(("t", "b", "inline", "r1.1"))
    steps = next(steps for node, steps in paths if node == ("t", "b", "connector", "16"))
    components = [
        detail["component"] for *_, detail in steps if detail.get("component") is not None
    ]
    assert [component.kind for component in components] == ["resistor", "unknown"]
    assert components[1].resistance_ohm is None
    assert any(detail.get("join", {}).get("basis") == joint["basis"] for *_, detail in steps)
    for operation, revision in [("cable.read", frozen), ("harness.read", harness)]:
        inspected = op(users["viewer"], operation, {"revision_id": revision["revision_id"]})
        assert any(
            row["local_id"] == "series"
            for endpoint in inspected["endpoints"]
            for row in endpoint["resolved_stack"]["joins"]
        )
        copper = op(users["viewer"], "copper.graph", {"revision_id": revision["revision_id"]})
        endpoint_id = "b" if operation == "cable.read" else "joined"

        def copper_component(terminal_id, current=copper, endpoint=endpoint_id):
            node = next(
                row["id"]
                for row in current["nodes"]
                if row["terminal"].get("endpoint_id") == endpoint
                and row["terminal"].get("layer_id") == "inline"
                and row["terminal"].get("terminal_id") == terminal_id
            )
            return next(row for row in current["components"] if node in row["members"])

        assert copper_component("r1.2") == copper_component("u2.1")
        assert copper_component("r1.1") != copper_component("r1.2")
        assert copper_component("u2.1") != copper_component("u2.2")
        assert any(
            edge["basis"] == joint["basis"] and edge["kind"] == "join" for edge in copper["edges"]
        )
        assert any(
            row["kind"] == "unknown" and row["status"] == "not_evaluated"
            for row in copper["boundaries"]
        )
        dependencies = Revision.objects.get(id=revision["revision_id"]).snapshot.dependencies
        assert UUID(second["revision_id"]) in dependencies.values_list("revision_id", flat=True)
    assert bytes(Revision.objects.get(id=kit["end_b"]).snapshot.canonical) == original
    assert value["stack"]["joins"][-1] == declaration()["joins"][0]


def test_second_parts_current_authority_still_fences_joined_consumers(
    users, project, kit, monkeypatch, client
):
    from specmate.cables import queries as cable_queries
    from specmate.design import operations as design_operations
    from specmate.harnesses import queries as harness_queries

    value, end, _, frozen, harness, second = series(users, project, kit)
    before = bytes(Revision.objects.get(id=end["revision_id"]).snapshot.canonical)
    original = design_operations.authorize_snapshots
    denied = True

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        # Inject the existing current-authority boundary, not a live membership change.
        if denied and any(str(row.pk) == second["snapshot_id"] for row in snapshots):
            raise NotFound("Synthetic second inline source denied.")
        return original(user, snapshots, **kwargs)

    for module in [design_operations, cable_queries, harness_queries]:
        monkeypatch.setattr(module, "authorize_snapshots", guard)
    with pytest.raises(NotFound):
        op(users["viewer"], "end_assembly.resolve", {"stack": value["stack"]})
    for operation, revision in [("cable.read", frozen), ("harness.read", harness)]:
        with pytest.raises(NotFound):
            op(users["viewer"], operation, {"revision_id": revision["revision_id"]})
    client.force_login(users["viewer"])
    body = {
        "operation": "end_assembly.resolve",
        "payload": {"stack": value["stack"]},
        "request_id": "series-denial",
    }
    response = client.post("/api/v0/operations", body, content_type="application/json")
    assert response.status_code == 404
    assert "Synthetic catalog identity" not in response.content.decode()
    denied = False
    assert (
        client.post(
            "/api/v0/operations",
            {**body, "request_id": "series-restored"},
            content_type="application/json",
        ).status_code
        == 200
    )
    assert op(users["viewer"], "cable.read", {"revision_id": frozen["revision_id"]})
    assert bytes(Revision.objects.get(id=end["revision_id"]).snapshot.canonical) == before


def test_legacy_cross_layer_join_keeps_literal_canonical_bytes_and_cross_end_fields_rejected():
    literal = {
        "layers": [
            {
                "kind": "inline",
                "layer_id": "inline",
                "parts": [
                    {
                        "local_id": "a",
                        "label": None,
                        "component": {
                            "kind": "unknown",
                            "value": None,
                            "reference": None,
                            "resistance_ohm": None,
                            "capacitance_f": None,
                        },
                    }
                ],
            },
            {"kind": "shell", "layer_id": "shell", "part_revision_id": None, "label": None},
        ],
        "joins": [
            {
                "local_id": "legacy",
                "a": {"layer_id": "inline", "terminal_id": "a.2"},
                "b": {"layer_id": "shell", "terminal_id": "body"},
                "kind": "bond",
                "basis": "Explicit legacy shell bond",
            }
        ],
    }
    expected = json.dumps(literal, sort_keys=True, separators=(",", ":")).encode()
    actual = EndStack.model_validate(literal).model_dump(mode="json")
    assert json.dumps(actual, sort_keys=True, separators=(",", ":")).encode() == expected
    literal["joins"][0]["b"]["endpoint_id"] = "another-end"
    with pytest.raises(ValidationError):
        EndStack.model_validate(literal)
