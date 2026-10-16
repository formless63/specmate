"""Occurrence-local declared switch choices preserve open and unknown contacts."""

import copy

import pytest

from specmate.interfaces import examples
from specmate.operations import ValidationFailed

from .conftest import op
from .test_cable_end_stacks import make_cable
from .test_cable_intent_check import demo  # noqa: F401 - shared synthetic fixture
from .test_interface_ports import frozen


def test_exact_board_condition_choices_select_only_one_path(users, project, demo):  # noqa: F811
    owner = users["owner"]
    board = examples.av_adapter_board(demo["plug"])
    selected = next(p for p in board["paths"] if p["to_terminal"] == "din-2")
    selected.update(via="switch", switch={"condition_key": "route", "closed_when": "direct"})
    board["conditions"] = [
        {
            "key": "route",
            "name": "Route",
            "choices": [{"key": "direct", "name": "Direct"}, {"key": "open", "name": "Open"}],
        }
    ]
    pin = frozen(owner, project, board, "Synthetic switch board")
    base = examples.din_adapter_end(pin, demo["plug"], demo["plug_variant"], None)
    results = {}
    for state in (None, "direct", "open"):
        end = copy.deepcopy(base)
        layer = end["stack"]["layers"][0]
        if state:
            layer["condition_states"] = {"route": state}
        end_pin = frozen(owner, project, end, f"Synthetic state {state}")
        cable = examples.av_demo_cable(demo["stock"], end_pin, demo["end_b"])
        cable["intent_revision_id"] = demo["intent"]
        revision = make_cable(owner, project, cable)[1]
        view = op(users["viewer"], "interface.read", {"revision_id": end_pin})["end_stack"]
        path = next(p for p in view["layers"][0]["paths"] if p["local_id"] == selected["local_id"])
        assert (
            path["contact_state"] == {None: "unknown", "direct": "declared", "open": "open"}[state]
        )
        check = op(
            users["viewer"], "cable_intent.check", {"cable_revision_id": revision["revision_id"]}
        )
        results[state] = next(r for r in check["rows"] if r["row_id"] == "from-2")["dimensions"][
            "connection"
        ]["status"]
        copper = op(users["viewer"], "copper.graph", {"revision_id": revision["revision_id"]})
        boundary = next(
            b
            for b in copper["boundaries"]
            if b["provenance"].get("declaration", {}).get("local_id") == selected["local_id"]
        )
        assert boundary["provenance"]["declaration"]["contact_state"] == path["contact_state"]
    assert results == {None: "unknown", "direct": "pass", "open": "fail"}
    for states in ({"missing": "direct"}, {"route": "missing"}):
        invalid = copy.deepcopy(base)
        invalid["stack"]["layers"][0]["condition_states"] = states
        with pytest.raises(ValidationFailed, match="condition selection"):
            frozen(owner, project, invalid, "Invalid exact state")
