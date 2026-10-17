"""Exact intent connector choices and stock-specific section checks."""

import copy
import json

import pytest
from pydantic import ValidationError

from specmate.cables.contracts import Cable, SectionCable
from specmate.design.models import Revision
from specmate.interfaces import examples
from specmate.operations import ValidationFailed

from .conftest import op
from .test_cable_end_stacks import make_cable
from .test_cable_intent_check import demo  # noqa: F401
from .test_interface_ports import frozen

# ruff: noqa: F811


def section_content(demo):
    cable = examples.av_demo_cable(demo["stock"], demo["end_a"], demo["end_b"])
    joints = []
    for n, assignment in enumerate(cable["assignments"]):
        source = assignment["endpoint_id"] == "a"
        joints.append(
            {
                "local_id": f"landing-{n}",
                "kind": "termination",
                "members": [
                    {
                        "kind": "segment",
                        "segment_id": "lead-a" if source else "lead-b",
                        "end": "a" if source else "b",
                        "element_path": assignment["element_path"],
                    },
                    {
                        "kind": "endpoint",
                        "endpoint_id": assignment["endpoint_id"],
                        "layer_id": assignment["layer_id"],
                        "terminal_id": assignment["terminal_id"],
                    },
                ],
                "basis": "Independent synthetic termination table",
            }
        )
    grouped = {}
    for joint in joints:
        target = joint["members"][1]
        key = (target["endpoint_id"], target["layer_id"], target["terminal_id"])
        if key in grouped:
            grouped[key]["members"].insert(0, joint["members"][0])
            grouped[key]["kind"] = "solder"
        else:
            grouped[key] = joint
    joints = list(grouped.values())
    for n, path in enumerate(sorted({a["element_path"] for a in cable["assignments"]})):
        joints.append(
            {
                "local_id": f"splice-{n}",
                "kind": "splice",
                "members": [
                    {"kind": "segment", "segment_id": segment, "end": end, "element_path": path}
                    for segment, end in [("lead-a", "b"), ("lead-b", "a")]
                ],
                "basis": "Declared separate physical pieces joined here",
            }
        )
    return {
        "schema_version": "0.3",
        "intent_revision_id": demo["intent"],
        "intent_endpoints": [
            {"side": side, "endpoint_id": endpoint, "layer_id": "connector"}
            for side, endpoint in [("from", "a"), ("to", "b")]
        ],
        "sections": [
            {
                "local_id": part,
                "stock_revision_id": demo["stock"],
                "planned_cut_length_mm": "100",
                "cut_basis": "Synthetic cut",
            }
            for part in ["piece-a", "piece-b"]
        ],
        "segments": [
            {"local_id": f"lead-{letter}", "section_id": f"piece-{letter}"} for letter in "ab"
        ],
        "endpoints": [{k: v for k, v in e.items() if k != "stock_end"} for e in cable["endpoints"]],
        "joints": joints,
    }


def test_section_intent_uses_exact_choices_and_reports_known_vs_unevaluated_dimensions(
    users, project, demo
):
    content = section_content(demo)
    revision = make_cable(users["owner"], project, content)[1]
    result = op(
        users["viewer"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]}
    )
    red = next(r for r in result["rows"] if r["row_id"] == "from-4")
    assert red["dimensions"]["connection"]["status"] == "pass"
    assert red["dimensions"]["conductor"]["status"] == "pass"
    assert red["dimensions"]["return"]["status"] == "pass"
    refs = [chip.get("ref", {}) for chip in red["path"]]
    assert {r["section_id"] for r in refs if "section_id" in r} == {"piece-a", "piece-b"}
    assert all("::" not in r.get("element_path", "") for r in refs)
    assert result["ends"]["from"]["layer_id"] == "connector"
    bad = copy.deepcopy(content)
    bad["intent_endpoints"][0]["layer_id"] = "board"
    with pytest.raises(ValidationFailed, match="exact endpoint connector"):
        make_cable(users["owner"], project, bad)


def test_section_impedance_belongs_to_each_exact_stock_not_the_first_section(users, project, demo):
    content = section_content(demo)
    stock = Revision.objects.get(id=demo["stock"])
    second = json.loads(bytes(stock.snapshot.canonical))["content"]["stock"]
    second["facts"]["impedance"]["value"] = 50
    # Freeze an independently declared second stock; the original 75-ohm stock is untouched.
    draft = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": str(stock.definition.workspace_id),
            "kind": "wire_stock",
            "name": "Synthetic second 50 ohm stock",
            "content": {"stock": second},
        },
    )
    pinned = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    content["sections"][1]["stock_revision_id"] = pinned["revision_id"]
    revision = make_cable(users["owner"], project, content)[1]
    result = op(
        users["viewer"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]}
    )
    red = next(r for r in result["rows"] if r["row_id"] == "from-4")
    assert red["dimensions"]["conductor"]["status"] == "fail"
    assert "50 ohm" in red["dimensions"]["conductor"]["reason"]


def test_required_component_placement_is_checked_and_not_matched_at_other_end(users, project, demo):
    value = section_content(demo)
    original = Revision.objects.get(id=demo["intent"])
    intent = json.loads(bytes(original.snapshot.canonical))["content"]["interface"]
    sync = next(r for r in intent["rows"] if r["row_id"] == "from-1")
    sync["required_parts"] = [
        {
            "conditioning": "series_resistor",
            "value": "470R",
            "where": "to_end",
            "basis": "Independent destination requirement",
        }
    ]
    value["intent_revision_id"] = frozen(
        users["owner"], project, intent, "Synthetic opposite-end resistor requirement"
    )
    revision = make_cable(users["owner"], project, value)[1]
    result = op(
        users["viewer"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]}
    )
    row = next(r for r in result["rows"] if r["row_id"] == "from-1")
    assert row["dimensions"]["required_parts"]["status"] == "fail"
    assert "to_end" in row["dimensions"]["required_parts"]["reason"]


def test_intent_mapping_requires_two_distinct_connector_occurrences_and_legacy_omission(demo):
    old = examples.av_demo_cable(demo["stock"], demo["end_a"], demo["end_b"])
    assert "intent_endpoints" not in Cable.model_validate(old).model_dump(mode="json")
    content = section_content(demo)
    content["intent_endpoints"] = content["intent_endpoints"][:1]
    with pytest.raises(ValidationError, match="both intent sides"):
        SectionCable.model_validate(content)


def test_per_contact_binding_selects_exact_repeated_connector_without_first_match(
    users, project, demo
):
    value = section_content(demo)
    value["intent_endpoints"] = []
    value["intent_contact_bindings"] = [
        {
            "side": side,
            "intent_contact_id": contact,
            "endpoint_id": endpoint,
            "layer_id": "connector",
            "terminal_id": contact,
            "basis": "Independent exact contact map",
        }
        for side, endpoint, contacts in [
            ("from", "a", [str(n) for n in range(1, 10)]),
            ("to", "b", [str(n) for n in range(1, 21)]),
        ]
        for contact in contacts
    ]
    revision = make_cable(users["owner"], project, value)[1]
    result = op(
        users["viewer"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]}
    )
    red = next(r for r in result["rows"] if r["row_id"] == "from-4")
    assert red["dimensions"]["connection"]["status"] == "pass"
    assert red["dimensions"]["mating"]["status"] == "pass"
    assert red["dimensions"]["return"]["status"] == "pass"
    saved = Revision.objects.get(id=demo["end_a"])
    stack = json.loads(bytes(saved.snapshot.canonical))["content"]["interface"]["stack"]
    stack["graph_version"] = "0.2"
    board = next(layer for layer in stack["layers"] if layer["kind"] == "board")
    board["carried_connector_layer_id"] = "connector"
    connector = next(layer for layer in stack["layers"] if layer["kind"] == "connector")
    stack["layers"].insert(-1, {**connector, "layer_id": "unwired-copy"})
    value["endpoints"][0] = {"local_id": "a", "stack": stack}
    red_binding = next(
        binding
        for binding in value["intent_contact_bindings"]
        if binding["side"] == "from" and binding["intent_contact_id"] == "4"
    )
    red_binding["layer_id"] = "unwired-copy"
    second = make_cable(users["owner"], project, value)[1]
    result = op(users["viewer"], "cable_intent.check", {"cable_revision_id": second["revision_id"]})
    red = next(r for r in result["rows"] if r["row_id"] == "from-4")
    assert red["dimensions"]["connection"]["status"] == "fail"


@pytest.mark.parametrize("section", [False, True])
@pytest.mark.parametrize("expected_signal", ["unspecified", "explicit_wrong"])
def test_signal_matching_requires_an_explicit_expected_identity_without_weakening_other_checks(
    users, project, demo, section, expected_signal
):
    from specmate.operations import NotFound

    original = Revision.objects.get(id=demo["intent"])
    intent = json.loads(bytes(original.snapshot.canonical))["content"]["interface"]
    ground = next(r for r in intent["rows"] if r["row_id"] == "from-3")
    ground["signal_ref"] = (
        None
        if expected_signal == "unspecified"
        else next(r["signal_ref"] for r in intent["rows"] if r["row_id"] == "from-4")
    )
    value = (
        section_content(demo)
        if section
        else examples.av_demo_cable(demo["stock"], demo["end_a"], demo["end_b"])
    )
    value["intent_revision_id"] = frozen(
        users["owner"], project, intent, "Synthetic independent ground expectation"
    )
    revision = make_cable(users["owner"], project, value)[1]
    report = op(
        users["viewer"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]}
    )
    row = next(r for r in report["rows"] if r["row_id"] == "from-3")
    assert row["dimensions"]["connection"]["status"] == "pass"
    assert row["dimensions"]["isolation"]["status"] == "pass"
    if expected_signal == "unspecified":
        assert row["dimensions"]["signal_match"]["status"] == "unknown"
        assert row["outcome"] == "unknown"
    else:
        assert row["dimensions"]["signal_match"]["status"] == "fail"
        assert row["outcome"] == "fail"
    with pytest.raises(NotFound):
        op(users["outsider"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]})
