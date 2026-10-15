"""Propose a cable test plan from a frozen cable and its intent (CAB-004, CAB-006 proposed).

Expected expectations are derived by hand from the synthetic tables in
``interfaces.examples`` (DIN_SHARED, RGB_PINS, ADAPTER_PADS, DEMO_CENTRES/SCREENS):

- eight wired signal rows (DIN 1, 2, 3, 4, 5, 6, 7, 9) give nine continuity pairs: video
  ground (3) reaches both monitor 5 and 17; sync (1 -> 20) passes the board's 470 R, so
  it expects 470 ohm in series;
- the eight rows share no intended contact: 8 * 7 / 2 = 28 isolation pairs between them;
- +5 V (8) must not connect: one isolation pair against each of the eight nets;
- chassis (optional, not wired) and blanking (no source pin) propose nothing.
"""

import pytest

from specmate.design.models import Definition
from specmate.interfaces import examples
from specmate.operations import ValidationFailed

from . import test_cable_intent_check
from .conftest import op
from .scope_helpers import workspace_of
from .test_cable_end_stacks import make_cable

demo = test_cable_intent_check.demo


def derive(users, project, demo, builder=examples.av_demo_cable, pin_intent=True):
    cable = builder(demo["stock"], demo["end_a"], demo["end_b"])
    if pin_intent:
        cable["intent_revision_id"] = demo["intent"]
    revision = make_cable(users["owner"], project, cable)[1]["revision_id"]
    payload = {"root_revision_id": revision, "cable_revision_id": revision}
    return revision, payload


def pairs_by(result, intent):
    return [p for p in result["test_plan"]["pairs"] if p["intent"] == intent]


def contacts(pair):
    return (
        (pair["first"]["endpoint_id"], pair["first"]["contact_id"]),
        (pair["second"]["endpoint_id"], pair["second"]["contact_id"]),
    )


def test_correct_cable_proposes_continuity_isolation_and_labels(users, project, demo):
    _, payload = derive(users, project, demo)
    before = Definition.objects.filter(kind="cable_test_plan").count()
    result = op(users["viewer"], "cable_test_plan.derive_from_intent", payload)
    assert Definition.objects.filter(kind="cable_test_plan").count() == before
    assert result["stored"] is False and result["review"] == "required"
    assert result["physical_continuity"] == "not_evaluated"
    assert result["counts"] == {"continuity": 9, "isolation": 36, "unknown": 0}

    continuity = {contacts(p): p for p in pairs_by(result, "continuity")}
    # The cable's plug mates the console port by same contact IDs; the RGB plug likewise.
    assert set(continuity) == {
        (("a", "1"), ("b", "20")),
        (("a", "2"), ("b", "7")),
        (("a", "3"), ("b", "5")),
        (("a", "3"), ("b", "17")),
        (("a", "4"), ("b", "15")),
        (("a", "5"), ("b", "1")),
        (("a", "6"), ("b", "11")),
        (("a", "7"), ("b", "4")),
        (("a", "9"), ("b", "3")),
    }
    sync = continuity[(("a", "1"), ("b", "20"))]
    assert sync["expected_resistance_ohm"] == 470
    assert "470" in sync["basis"] and sync["signal"].startswith("Composite sync")
    red = continuity[(("a", "4"), ("b", "15"))]
    assert red["expected_resistance_ohm"] is None and red["signal"].startswith("Red video")
    assert red["derived_from"] == {"intent_revision_id": demo["intent"], "row_ids": ["from-4"]}

    isolation = [contacts(p) for p in pairs_by(result, "isolation")]
    assert all(a[0] == b[0] == "a" for a, b in isolation)
    power = [pair for pair in isolation if ("a", "8") in pair]
    assert len(power) == 8
    assert (("a", "2"), ("a", "4")) in isolation or (("a", "4"), ("a", "2")) in isolation

    rows = {r["row_id"]: r for r in result["rows"]}
    assert rows["from-shell"]["pairs"] == [] and "not wire" in rows["from-shell"]["reasons"][0]
    assert rows["to-16"]["pairs"] == []

    labels = result["test_plan"]["labels"]
    texts = {
        (lbl["terminal"]["endpoint_id"], lbl["terminal"]["contact_id"]): lbl["text"]
        for lbl in labels
        if lbl.get("terminal")
    }
    assert texts[("a", "4")] == "4 · Red video" and texts[("b", "15")] == "15 · Red video"
    assert texts[("a", "8")].startswith("8 · ")
    ends = [lbl for lbl in labels if lbl.get("endpoint_id")]
    assert {e["endpoint_id"] for e in ends} == {"a", "b"}

    # The proposal is a valid draft body; review and freeze stay separate steps.
    draft = op(
        users["owner"],
        "cable_test_plan.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Proposed bench plan",
            "test_plan": result["test_plan"],
        },
    )
    assert draft["draft_id"]
    assert Definition.objects.filter(kind="cable_test_plan").count() == before + 1


def test_swapped_cable_proposes_no_continuity_for_the_swapped_rows(users, project, demo):
    _, payload = derive(users, project, demo, examples.av_swapped_cable)
    result = op(users["viewer"], "cable_test_plan.derive_from_intent", payload)
    continuity = {contacts(p) for p in pairs_by(result, "continuity")}
    assert (("a", "4"), ("b", "15")) not in continuity
    assert (("a", "2"), ("b", "7")) not in continuity
    rows = {r["row_id"]: r for r in result["rows"]}
    assert rows["from-4"]["pairs"] == []
    assert "No declared path to 15 · Red video" in rows["from-4"]["reasons"][0]


def test_cable_without_an_intent_needs_one_named(users, project, demo):
    _, payload = derive(users, project, demo, pin_intent=False)
    with pytest.raises(ValidationFailed, match="pins no cable intent"):
        op(users["viewer"], "cable_test_plan.derive_from_intent", payload)
    result = op(
        users["viewer"],
        "cable_test_plan.derive_from_intent",
        {**payload, "intent_revision_id": demo["intent"]},
    )
    assert result["counts"]["continuity"] == 9


def test_expected_resistance_belongs_to_continuity():
    from pydantic import ValidationError

    from specmate.cable_test_intent.contracts import PairExpectation

    terminal = {"endpoint_id": "a", "kind": "contact", "contact_id": "1"}
    with pytest.raises(ValidationError):
        PairExpectation.model_validate(
            {
                "local_id": "p",
                "first": terminal,
                "second": {**terminal, "contact_id": "2"},
                "intent": "isolation",
                "basis": "x",
                "expected_resistance_ohm": 10,
            }
        )
