"""Original harness/PCB explanation fixture; extraction payloads are synthetic, not native proof."""

import pytest

from .conftest import op
from .test_copper import assembly, board_population
from .test_harnesses import capture, create, fixture
from .test_passive_passages import interpretation, review
from .test_pcb import attempt as pcb_attempt  # noqa: F401
from .test_pcb import intake, recipe, source  # noqa: F401


@pytest.mark.parametrize("kind", ["resistor", "active"])
def test_harness_to_board_path_preserves_exact_origins_and_unknown_active_behavior(
    users, project, request, kind
):
    owner = users["owner"]
    *_, harness = fixture(owner, project)
    lead = capture(owner, create(owner, project, harness))
    population, report = board_population(users, request.getfixturevalue("pcb_attempt"))
    board = op(
        owner,
        "pcb.population_freeze",
        {"draft_id": population["draft_id"]},
        expected_state=population["state"],
    )
    root = assembly(owner, project, [("lead", lead), ("board", board)])
    graph = op(owner, "copper.graph", {"revision_id": root["revision_id"]})
    lead_nodes = {
        n["terminal"]["endpoint_id"]: n
        for n in graph["nodes"]
        if n["occurrence_path"] == ["lead"]
        and n["terminal"].get("kind") == "endpoint"
        and (n["terminal"]["endpoint_id"], n["terminal"].get("contact_id"))
        in (("input", "a"), ("output", "b"))
    }
    board_nodes = {n["label"]: n for n in graph["nodes"] if n["occurrence_path"] == ["board"]}
    lead_component = next(
        c for c in graph["components"] if lead_nodes["input"]["id"] in c["members"]
    )
    assert board_nodes["J1.1"]["id"] not in lead_component["members"]
    candidate = next(b for b in graph["boundaries"] if b["kind"] == "resistor")
    model = {
        "root_revision_id": root["revision_id"],
        "assumptions": "ideal_lumped_components",
        "model_basis": "Original synthetic harness/board model; no physical mating is inferred.",
        "passages": [
            {
                "local_id": "explicit-interface",
                "kind": "resistor",
                "from_terminal_id": lead_nodes["output"]["id"],
                "to_terminal_id": board_nodes["J1.1"]["id"],
                "resistance_ohm": "0",
                "basis": "Explicit ideal zero resistance bridge; no qualified association.",
            },
            {
                "local_id": "separate-component-behavior",
                "kind": kind,
                "from_terminal_id": board_nodes["R1.1"]["id"],
                "to_terminal_id": board_nodes["R1.2"]["id"],
                "resistance_ohm": "330" if kind == "resistor" else None,
                "native_candidate_boundary_id": candidate["id"],
                "basis": "Separate controlled assertion; extracted R label/value are not truth.",
            },
        ],
    }
    draft = op(
        owner,
        "passage.create",
        {"project_id": project, "name": "Harness board explanation fixture", "model": model},
    )
    frozen = op(
        owner, "passage.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    reviewed = review(owner, frozen)
    result = interpretation(
        owner,
        frozen,
        {"a": lead_nodes["input"]["id"], "b": board_nodes["J2.1"]["id"]},
        "resistance",
    )
    assert result["root_revision_id"] == graph["root_revision_id"]
    assert result["root_snapshot_sha256"] == graph["snapshot_sha256"]
    assert result["review_id"] == reviewed["reviews"][-1]["review_id"]
    assert len(result["paths"]) == 1
    path = result["paths"][0]
    assert path["terminal_ids"][0] == lead_nodes["input"]["id"]
    assert path["terminal_ids"][-1] == board_nodes["J2.1"]["id"]
    assert set(path["terminal_ids"]) <= {n["id"] for n in graph["nodes"]}
    copper_steps = [s for s in path["steps"] if s["evidence"] == "declared_copper"]
    assert copper_steps and {tuple(s["provenance"]["occurrence_path"]) for s in copper_steps} == {
        ("lead",)
    }
    assert all(s["provenance"]["revision_id"] == lead["revision_id"] for s in copper_steps)
    native_steps = [s for s in path["steps"] if s["kind"] == "native_net"]
    assert len(native_steps) == 2
    assert {s["provenance"]["native_net_name"] for s in native_steps} == {"left", "right"}
    assert all(s["evidence"] == "reported_net_membership" for s in native_steps)
    for step in native_steps:
        origin = step["provenance"]
        assert origin["occurrence_path"] == ["board"]
        assert origin["revision_id"] == board["revision_id"]
        assert origin["native_net_id"] and origin["interpretation"]["source_revision_id"]
        assert len(origin["interpretation"]["sha256"]) == 64
    assert all(step["record_id"] for step in path["steps"])
    assert candidate in result["unmodeled_boundaries"]
    assert op(owner, "copper.graph", {"revision_id": root["revision_id"]}) == graph
    assert result["assumptions"]["copper"] == "ideal_zero_resistance"
    assert result["physical_continuity"] == result["physical_qualification"] == "not_evaluated"
    component_step = next(
        s for s in path["steps"] if s["record_id"] == "passage:separate-component-behavior"
    )
    assert component_step["kind"] == kind
    if kind == "resistor":
        assert result["series_resistance_ohm"] == "330"
        assert component_step["resistance_ohm"] == "330"
        assert report["component_passages"][0]["resistance_ohm"] == 100
    else:
        assert result["status"] == path["status"] == component_step["status"] == "unknown"
        assert result["series_resistance_ohm"] is None
        assert "operating_condition_or_supported_behavior_model_required" in path["reasons"]
