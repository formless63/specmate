"""Independent section-screen and local shield-bond oracles; no physical test claim."""

import json

import pytest

from specmate.design.models import Revision
from specmate.interfaces import examples

from .conftest import op
from .test_cable_end_stacks import make_cable
from .test_cable_intent_check import demo  # noqa: F401
from .test_interface_ports import frozen
from .test_section_cable_intents import section_content

# ruff: noqa: F811


def content_of(pin, key):
    return json.loads(bytes(Revision.objects.get(id=pin).snapshot.canonical))["content"][key]


def inspect(users, project, value):
    revision = make_cable(users["owner"], project, value)[1]
    return op(users["viewer"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]})


def red(result):
    return next(row for row in result["rows"] if row["row_id"] == "from-4")


def freeze_stock(user, project, stock):
    from .scope_helpers import workspace_of

    draft = op(
        user,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "wire_stock",
            "name": "Independent synthetic shield construction",
            "content": {"stock": stock},
        },
    )
    return op(user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"])[
        "revision_id"
    ]


def shielded(users, project, demo, *, bonded=True):
    value = section_content(demo)
    value["sections"] = value["sections"][:1]
    value["segments"] = [{"local_id": "lead", "section_id": "piece-a"}]
    value["joints"] = [joint for joint in value["joints"] if joint["kind"] != "splice"]
    for joint in value["joints"]:
        for member in joint["members"]:
            if member["kind"] == "segment":
                member["segment_id"] = "lead"
    stock = content_of(demo["stock"], "stock")
    stock["structure"]["children"].extend(
        [
            {"kind": "shield", "id": "foil", "label": "Overall foil"},
            {"kind": "drain", "id": "drain", "label": "Overall drain"},
        ]
    )
    stock["bonded_sets"] = (
        [
            {
                "local_id": "mass",
                "element_paths": ["stock.foil", "stock.drain"],
                "basis": "Independent explicit construction bond",
            }
        ]
        if bonded
        else []
    )
    value["sections"][0]["stock_revision_id"] = freeze_stock(users["owner"], project, stock)
    # Only the drain is made into a named tail. The foil is bonded only if the
    # independently declared stock construction says it touches that drain.
    value["segments"][0]["pigtails"] = [
        {
            "local_id": "overall-source",
            "end": "a",
            "element_paths": ["stock.drain"],
            "basis": "Independent source-only preparation",
        }
    ]
    joint = next(
        j
        for j in value["joints"]
        if any(m.get("endpoint_id") == "a" and m.get("terminal_id") == "gnd" for m in j["members"])
    )
    joint["members"].insert(
        0, {"kind": "pigtail", "segment_id": "lead", "end": "a", "pigtail_id": "overall-source"}
    )
    joint["kind"] = "solder"
    return value


def with_policy(users, project, demo, value, policy):
    intent = content_of(demo["intent"], "interface")
    intent["shield"] = {"policy": policy, "basis": "Independent synthetic end-bond requirement"}
    value["intent_revision_id"] = frozen(
        users["owner"], project, intent, "Independent shield intent"
    )
    return value


def test_missing_middle_screen_cannot_borrow_other_longitudinal_ground_wires(users, project, demo):
    value = section_content(demo)
    value["joints"] = [
        joint
        for joint in value["joints"]
        if not (
            joint["kind"] == "splice"
            and joint["members"][0]["element_path"] == "stock.core-1.screen"
        )
    ]
    result = red(inspect(users, project, value))
    assert result["dimensions"]["connection"]["status"] == "pass"
    assert result["dimensions"]["return"]["status"] == "fail"
    assert "no local landing" in result["dimensions"]["return"]["reason"]


def test_explicit_named_pigtail_is_a_real_local_return_landing(users, project, demo):
    value = section_content(demo)
    joint = next(
        j
        for j in value["joints"]
        if any(m.get("endpoint_id") == "a" and m.get("terminal_id") == "gnd" for m in j["members"])
    )
    material = [m for m in joint["members"] if m["kind"] == "segment"]
    value["segments"][0]["pigtails"] = [
        {
            "local_id": "video-return",
            "end": "a",
            "element_paths": [m["element_path"] for m in material],
            "basis": "Explicit grouped source return preparation",
        }
    ]
    joint["members"] = [m for m in joint["members"] if m["kind"] != "segment"] + [
        {"kind": "pigtail", "segment_id": "lead-a", "end": "a", "pigtail_id": "video-return"}
    ]
    joint["kind"] = "termination"
    result = red(inspect(users, project, value))
    assert result["dimensions"]["return"]["status"] == "pass"


@pytest.mark.parametrize(
    "policy, expected", [("bond_from", "pass"), ("bond_both", "fail"), ("isolated", "fail")]
)
def test_overall_stock_mass_has_only_its_declared_local_source_bond(
    users, project, demo, policy, expected
):
    value = with_policy(users, project, demo, shielded(users, project, demo), policy)
    assert inspect(users, project, value)["cable"]["shield"]["status"] == expected


def test_unbonded_foil_does_not_acquire_the_drain_landing(users, project, demo):
    value = with_policy(
        users, project, demo, shielded(users, project, demo, bonded=False), "bond_from"
    )
    assert inspect(users, project, value)["cable"]["shield"]["status"] == "fail"


def test_return_relation_must_belong_to_the_exact_independent_signal_set(users, project, demo):
    value = section_content(demo)
    signals = examples.av_signal_set()
    different_set = frozen(
        users["owner"], project, signals, "Different independent signal identities"
    )
    intent = content_of(demo["intent"], "interface")
    next(r for r in intent["rows"] if r["row_id"] == "from-4")["signal_ref"][
        "signal_set_revision_id"
    ] = different_set
    value["intent_revision_id"] = frozen(
        users["owner"], project, intent, "Different-set return requirement"
    )
    assert red(inspect(users, project, value))["dimensions"]["return"]["status"] == "unknown"


def test_shared_ground_requires_a_real_declared_return_path(users, project, demo):
    value = section_content(demo)
    intent = content_of(demo["intent"], "interface")
    next(r for r in intent["rows"] if r["row_id"] == "from-4")["return_policy"] = "shared_ground"
    value["intent_revision_id"] = frozen(
        users["owner"], project, intent, "Independent shared return requirement"
    )
    assert red(inspect(users, project, value))["dimensions"]["return"]["status"] == "pass"
    value["joints"] = [
        joint
        for joint in value["joints"]
        if not (
            joint["kind"] == "splice" and joint["members"][0]["element_path"].endswith(".screen")
        )
    ]
    assert red(inspect(users, project, value))["dimensions"]["return"]["status"] == "fail"


@pytest.mark.parametrize("return_policy", ["dedicated_screen", "shared_ground"])
def test_generic_ground_without_return_relation_stays_unknown(users, project, demo, return_policy):
    value = section_content(demo)
    signals = examples.av_signal_set()
    for signal in signals["signals"]:
        if signal["type"] == "ground_return":
            signal["return_for"] = []
    generic_set = frozen(users["owner"], project, signals, "Independent generic ground vocabulary")

    def rebind(item):
        if isinstance(item, dict):
            return {
                key: generic_set if key == "signal_set_revision_id" else rebind(child)
                for key, child in item.items()
            }
        return [rebind(child) for child in item] if isinstance(item, list) else item

    intent = content_of(demo["intent"], "interface")
    for field in ["from_revision_id", "to_revision_id"]:
        port = content_of(intent[field], "interface")
        pinout = rebind(content_of(port["pinout_revision_id"], "interface"))
        port["pinout_revision_id"] = frozen(
            users["owner"], project, pinout, "Independent generic-ground pin table"
        )
        intent[field] = frozen(users["owner"], project, port, "Independent generic-ground port")
    intent = rebind(intent)
    next(r for r in intent["rows"] if r["row_id"] == "from-4")["return_policy"] = return_policy
    value["intent_revision_id"] = frozen(
        users["owner"], project, intent, "Independent generic-ground requirement"
    )
    result = red(inspect(users, project, value))
    assert result["dimensions"]["connection"]["status"] == "pass"
    assert result["dimensions"]["return"]["status"] == "unknown"


def test_overall_shield_mass_continues_across_two_physical_pieces(users, project, demo):
    value = with_policy(users, project, demo, shielded(users, project, demo), "bond_both")
    value["sections"].append({**value["sections"][0], "local_id": "piece-b"})
    source = value["segments"][0]
    source["local_id"] = "lead-a"
    value["segments"].append(
        {
            "local_id": "lead-b",
            "section_id": "piece-b",
            "pigtails": [
                {
                    "local_id": "overall-sink",
                    "end": "b",
                    "element_paths": ["stock.drain"],
                    "basis": "Independent destination preparation",
                }
            ],
        }
    )
    for joint in value["joints"]:
        for member in joint["members"]:
            if member["kind"] in {"segment", "pigtail"}:
                member["segment_id"] = "lead-a" if member["end"] == "a" else "lead-b"
    destination = next(
        j
        for j in value["joints"]
        if any(m.get("endpoint_id") == "b" and m.get("terminal_id") == "5" for m in j["members"])
    )
    destination["members"].append(
        {"kind": "pigtail", "segment_id": "lead-b", "end": "b", "pigtail_id": "overall-sink"}
    )
    destination["kind"] = "solder"
    for n, path in enumerate(
        [f"stock.core-{core}.{part}" for core in range(1, 7) for part in ["center", "screen"]]
        + ["stock.foil", "stock.drain"]
    ):
        value["joints"].append(
            {
                "local_id": f"continuation-{n}",
                "kind": "splice",
                "members": [
                    {"kind": "segment", "segment_id": segment, "end": end, "element_path": path}
                    for segment, end in [("lead-a", "b"), ("lead-b", "a")]
                ],
                "basis": "Independent exact two-piece shield/conductor continuation",
            }
        )
    assert inspect(users, project, value)["cable"]["shield"]["status"] == "pass"


@pytest.mark.parametrize("policy", ["bond_from", "isolated"])
def test_unknown_local_board_passage_never_proves_bond_or_isolation(users, project, demo, policy):
    value = with_policy(users, project, demo, shielded(users, project, demo), policy)
    end = content_of(demo["end_a"], "interface")
    layer = next(layer for layer in end["stack"]["layers"] if layer["kind"] == "board")
    board = content_of(layer["board_revision_id"], "interface")
    path = next(path for path in board["paths"] if path["from_terminal"] == "gnd")
    path.update(via="unknown", component=None, switch=None)
    layer["board_revision_id"] = frozen(
        users["owner"], project, board, "Independent unknown ground passage"
    )
    value["endpoints"][0]["end_assembly_revision_id"] = frozen(
        users["owner"], project, end, "Independent unqualified source end"
    )
    assert inspect(users, project, value)["cable"]["shield"]["status"] == "unknown"


def test_group_impedance_does_not_spill_onto_an_unrelated_power_core(users, project, demo):
    value = section_content(demo)
    stock = content_of(demo["stock"], "stock")
    stock["facts"].pop("impedance", None)
    core = next(c for c in stock["structure"]["children"] if c["id"] == "core-1")
    core["facts"] = {
        "impedance": {
            "value": 75,
            "unit": "ohm",
            "status": "documented",
            "source": "Independent coax-only performance table",
        }
    }
    stock["structure"]["children"].append(
        {"id": "power", "kind": "conductor", "label": "Separate power core"}
    )
    stock_pin = freeze_stock(users["owner"], project, stock)
    for section in value["sections"]:
        section["stock_revision_id"] = stock_pin
    assert red(inspect(users, project, value))["dimensions"]["conductor"]["status"] == "pass"
    for joint in value["joints"]:
        for member in joint["members"]:
            if member.get("element_path") == "stock.core-1.center":
                member["element_path"] = "stock.power"
    intent = content_of(demo["intent"], "interface")
    row = next(r for r in intent["rows"] if r["row_id"] == "from-4")
    row["conductor"] = {
        "kind": "single",
        "impedance_ohm": 75,
        "basis": "Independent single-conductor requirement",
    }
    row["return_policy"] = "any"
    value["intent_revision_id"] = frozen(
        users["owner"], project, intent, "Independent power-core path counterexample"
    )
    result = red(inspect(users, project, value))
    assert result["dimensions"]["connection"]["status"] == "pass"
    assert result["dimensions"]["conductor"]["status"] == "unknown"
