"""Propose wiring from an intent (auto-construct), checked by the cable intent checker.

The expected assignments are the hand-built demo cable (``examples.av_demo_cable``):
each coax center on the board pad of its signal at the console end and on the monitor
contact of that signal; each screen on the ground pad of its signal's return, video
screens split over monitor contacts 5 and 17 in stock order, audio screens on 4.
"""

import pytest

from specmate.interfaces import examples

from .conftest import op
from .test_cable_intent_check import CORRECT, demo  # noqa: F401
from .test_interface_conventions import frozen_stock


def landed(cable):
    return sorted(
        (a["endpoint_id"], a["element_path"], a["layer_id"], a["terminal_id"])
        for a in cable["assignments"]
    )


def propose(user, payload):
    return op(user, "cable_intent.propose_cable", payload)


def ends(demo):  # noqa: F811
    return {
        "from_end": {"end_assembly_revision_id": demo["end_a"]},
        "to_end": {"end_assembly_revision_id": demo["end_b"]},
    }


def test_proposal_reproduces_the_hand_built_demo_cable(users, demo):  # noqa: F811
    result = propose(
        users["viewer"],
        {"intent_revision_id": demo["intent"], "stock_revision_id": demo["stock"], **ends(demo)},
    )
    expected = examples.av_demo_cable(demo["stock"], demo["end_a"], demo["end_b"])
    assert landed(result["cable"]) == landed(expected)
    assert result["questions"] == []
    assert {r["row_id"]: r["outcome"] for r in result["check"]["rows"]} == CORRECT
    rows = {r["row_id"]: r for r in result["rows"]}
    assert rows["from-4"]["conductor"] == "stock.core-1.center"
    assert rows["from-4"]["reason"].startswith("preferred by convention")
    assert rows["from-8"]["status"] == "not_wired"
    sync = [a for a in rows["from-1"]["assignments"] if a["endpoint_id"] == "a"]
    # Sync lands on the cable-side pad behind the 470 ohm part, not the connector-side pad.
    assert [a["terminal_id"] for a in sync] == ["cs"]
    assert result["cable"]["intent_revision_id"] == demo["intent"]
    assert result["status"] == "proposed" and result["review"] == "required"


def test_without_a_convention_equal_coax_are_questions(users, project, demo):  # noqa: F811
    plain = frozen_stock(users["owner"], project, name="Plain six-coax stock")
    result = propose(
        users["viewer"],
        {"intent_revision_id": demo["intent"], "stock_revision_id": plain, **ends(demo)},
    )
    ties = {q["row_id"]: q for q in result["questions"] if q["kind"] == "tie"}
    # Red is the first video row by contact order; every coax center is free and unranked.
    assert len(ties["from-2"]["options"]) == 6
    assert {"from-1", "from-2", "from-4", "from-5", "from-6", "from-9"} <= set(ties)
    assert {r["row_id"]: r["status"] for r in result["rows"]}["from-4"] == "question"
    # Nothing is landed for an undecided row.
    assert not [a for a in result["cable"]["assignments"] if a["element_path"].endswith("center")]


def test_missing_sync_part_is_a_question_with_a_development_need(users, demo):  # noqa: F811
    bare = {
        "stack": {
            "layers": [
                {
                    "kind": "connector",
                    "layer_id": "connector",
                    "body_revision_id": demo["plug"],
                    "pinout_revision_id": demo["plug_variant"],
                }
            ]
        }
    }
    result = propose(
        users["viewer"],
        {
            "intent_revision_id": demo["intent"],
            "stock_revision_id": demo["stock"],
            "from_end": bare,
            "to_end": {"end_assembly_revision_id": demo["end_b"]},
        },
    )
    [missing] = [q for q in result["questions"] if q["kind"] == "missing_part"]
    assert missing["row_id"] == "from-1"
    assert missing["development_need"]["need"] == "adapter_board"
    assert "series resistor 470 ohm" in missing["development_need"]["summary"]
    # Wiring is still proposed, plainly, and the checker fails its required part.
    sync = {r["row_id"]: r for r in result["check"]["rows"]}["from-1"]["dimensions"]
    assert sync["required_parts"]["status"] == "fail"
    red_a = [
        a
        for a in result["cable"]["assignments"]
        if a["endpoint_id"] == "a" and a["element_path"] == "stock.core-1.center"
    ]
    assert red_a[0]["layer_id"] == "connector" and red_a[0]["terminal_id"] == "4"


def test_draft_proposal_diffs_against_the_draft(users, demo):  # noqa: F811
    owner = users["owner"]
    cable = examples.av_swapped_cable(demo["stock"], demo["end_a"], demo["end_b"])
    cable["intent_revision_id"] = demo["intent"]
    draft = op(owner, "cable.create", {"name": "Swapped draft", "cable": cable})
    result = propose(
        users["viewer"], {"intent_revision_id": demo["intent"], "draft_id": draft["draft_id"]}
    )
    changed = {
        (d["endpoint_id"], d["element_path"]) for d in result["diff"] if d["change"] != "same"
    }
    assert changed == {("a", "stock.core-1.center"), ("a", "stock.core-3.center")}


def test_new_proposal_needs_stock_and_ends(users, demo):  # noqa: F811
    from specmate.operations import ValidationFailed

    with pytest.raises(ValidationFailed):
        propose(users["viewer"], {"intent_revision_id": demo["intent"]})
