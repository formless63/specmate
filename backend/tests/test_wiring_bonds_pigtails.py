"""Stock construction, end preparation and material ownership are independent."""

import copy
import json

import pytest

from specmate.design.models import Revision
from specmate.operations import ValidationFailed
from specmate.wire_stock.electrical import impedance_fact, ohm_value
from specmate.wire_stock.schemas import StockSpecification

from .conftest import op
from .scope_helpers import workspace_of
from .test_harnesses import fixture
from .test_section_cables import create, freeze


def prepared(user, project, *, bonded=False, pigtail=True):
    stock, _, _, original = fixture(user, project)
    source = Revision.objects.get(id=stock["revision_id"])
    content = json.loads(bytes(source.snapshot.canonical))["content"]["stock"]
    content["bonded_sets"] = (
        [
            {
                "local_id": "screens",
                "element_paths": ["stock.screen", "stock.drain"],
                "basis": "Explicit inherent construction bond",
            }
        ]
        if bonded
        else []
    )
    draft = op(
        user,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "wire_stock",
            "name": "Synthetic bonded stock" if bonded else "Synthetic separate screens",
            "content": {"stock": content},
        },
    )
    stock_pin = op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    endpoint = original["endpoints"][0]
    value = {
        "schema_version": "0.3",
        "sections": [
            {
                "local_id": "piece",
                "stock_revision_id": stock_pin["revision_id"],
                "planned_cut_length_mm": "100",
                "cut_basis": "Independent cut oracle",
            }
        ],
        "segments": [{"local_id": "lead", "section_id": "piece"}],
        "endpoints": [
            {
                "local_id": "source",
                "stack": {
                    "layers": [
                        {
                            "kind": "connector",
                            "layer_id": "plug",
                            "body_revision_id": endpoint["body_revision_id"],
                            "pinout_revision_id": endpoint["pinout_revision_id"],
                        }
                    ],
                    "joins": [],
                },
            }
        ],
        "joints": [],
    }
    if pigtail:
        value["segments"][0]["pigtails"] = [
            {
                "local_id": "return-tail",
                "end": "a",
                "label": "Source return pigtail",
                "element_paths": ["stock.screen", "stock.drain"],
                "basis": "Explicit source-end screen preparation",
            }
        ]
        value["joints"] = [
            {
                "local_id": "source-land",
                "kind": "termination",
                "members": [
                    {
                        "kind": "pigtail",
                        "segment_id": "lead",
                        "end": "a",
                        "pigtail_id": "return-tail",
                    },
                    {
                        "kind": "endpoint",
                        "endpoint_id": "source",
                        "layer_id": "plug",
                        "terminal_id": "a",
                    },
                ],
                "basis": "One prepared tail landed once on ordinary signal/ground pad",
            }
        ]
    return value, content


def graph(user, revision):
    return op(user, "copper.graph", {"revision_id": revision["revision_id"]})


def test_named_pigtail_lands_once_adds_no_material_and_keeps_source_only_preparation(
    users, project
):
    value, _ = prepared(users["owner"], project)
    r = freeze(users["owner"], create(users["owner"], project, value))
    result = op(users["viewer"], "cable.read", {"revision_id": r["revision_id"]})
    assert result["quantities"]["physical_piece_count"] == 1
    assert result["quantities"]["stock"][0]["planned_cut_total_mm"] == "100"
    assert len(result["declared_relationships"]) == 1
    assert len(result["pigtail_preparations"]) == 1
    assert result["pigtail_preparations"][0]["physical_piece_count_added"] == 0
    assert result.get("construction_bonds", []) == []
    assert {m["end"] for m in result["pigtail_preparations"][0]["members"]} == {"a"}
    copper = graph(users["viewer"], r)
    tail = next(n for n in copper["nodes"] if n["terminal"]["kind"] == "pigtail")
    assert tail["terminal"]["pigtail_id"] == "return-tail"
    prep = next(
        e
        for e in copper["edges"]
        if e["provenance"].get("declaration", {}).get("kind") == "pigtail_preparation"
    )
    assert len(prep["members"]) == 3
    target = op(
        users["viewer"],
        "cable_test_plan.inspect_target",
        {"root_revision_id": r["revision_id"], "cable_revision_id": r["revision_id"]},
    )
    assert any(t["terminal"].get("kind") == "pigtail" for t in target["terminals"])
    from .test_preparation_documents import configuration, files, retain

    _, retained = retain(users["owner"], configuration(r), key="pigtail-documents")
    outputs = files(users["viewer"], retained)
    assert b"pigtail_preparation" in outputs["schematic.svg"]
    assert b"Source return pigtail" in outputs["schematic.svg"]
    bad = copy.deepcopy(value)
    bad["joints"].append(
        {
            "local_id": "duplicate-landing",
            "kind": "termination",
            "members": [
                {
                    "kind": "segment",
                    "segment_id": "lead",
                    "end": "a",
                    "element_path": "stock.drain",
                },
                {
                    "kind": "endpoint",
                    "endpoint_id": "source",
                    "layer_id": "plug",
                    "terminal_id": "b",
                },
            ],
            "basis": "Cannot land prepared members separately",
        }
    )
    with pytest.raises(ValidationFailed, match="conflicting joint"):
        create(users["owner"], project, bad)


def test_intrinsic_stock_bonds_are_not_end_joints_and_separate_screens_stay_separate(
    users, project
):
    value, _ = prepared(users["owner"], project, bonded=True, pigtail=False)
    r = freeze(users["owner"], create(users["owner"], project, value))
    result = op(users["viewer"], "cable.read", {"revision_id": r["revision_id"]})
    assert len(result["construction_bonds"]) == 2
    assert result["declared_relationships"] == []
    bonded_graph = graph(users["viewer"], r)
    assert len([e for e in bonded_graph["edges"] if e["kind"] == "stock_bond"]) == 2
    separate, _ = prepared(users["owner"], project, bonded=False, pigtail=False)
    other = freeze(users["owner"], create(users["owner"], project, separate))
    separate_graph = graph(users["viewer"], other)
    assert not any(e["kind"] == "stock_bond" for e in separate_graph["edges"])
    assert len(bonded_graph["components"]) + 1 == len(separate_graph["components"])


def test_scoped_impedance_never_spills_from_coax_group_to_power_core(users, project):
    _, raw = prepared(users["owner"], project, pigtail=False)
    core, screen, drain = raw["structure"]["children"][:3]
    raw["structure"]["children"] = [
        {
            "kind": "group",
            "id": "coax",
            "label": "Declared coax line",
            "role": "coax",
            "children": [core, screen, drain],
            "facts": {
                "impedance": {
                    "value": 75.0,
                    "unit": "ohm",
                    "status": "documented",
                    "source": "Independent scoped source",
                }
            },
        },
        {"kind": "conductor", "id": "power", "label": "Separate power core"},
    ]
    raw["facts"].pop("impedance", None)
    spec = StockSpecification.model_validate(raw)
    assert ohm_value(impedance_fact(spec, "stock.coax.core")) == 75.0
    assert impedance_fact(spec, "stock.power") is None
    assert impedance_fact(spec, "stock.missing") is None
