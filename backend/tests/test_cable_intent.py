"""CAB-006 (proposed)/INT-003: cable intent with proposed signal rows and questions.

Expected rows are derived by hand from the synthetic pin tables in
``interfaces.examples`` (DIN_SHARED, DIN_PIN_1, RGB_PINS and the port facts).
"""

import copy

import pytest

from specmate.interfaces import examples
from specmate.operations import NotFound, ValidationFailed

from .conftest import op
from .test_interface_ports import (
    av,  # noqa: F401
    create,
    freeze,
    frozen,
)


@pytest.fixture
def ends(users, project, av):  # noqa: F811
    owner = users["owner"]
    return {
        **av,
        "console_a": frozen(
            owner,
            project,
            examples.console_port(av["variants"]["Console A AV"], "Console A AV out"),
            "Console A AV out",
        ),
        "console_b": frozen(
            owner,
            project,
            examples.console_port(av["variants"]["Console B AV"], "Console B AV out"),
            "Console B AV out",
        ),
        "monitor": frozen(
            owner, project, examples.rgb_monitor_port(av["sink"]), "RGB monitor 21-pin input"
        ),
    }


def propose(user, source, target):
    return op(user, "cable_intent.propose", {"from_revision_id": source, "to_revision_id": target})


def by_row(proposal):
    return {r["row_id"]: r for r in proposal["rows"]}


def test_console_a_to_monitor_pairs_by_signal_identity_and_asks_the_rest(users, ends):
    proposal = propose(users["viewer"], ends["console_a"], ends["monitor"])
    rows = by_row(proposal)
    paired = {
        r["from_contact_id"]: r["to_contact_ids"]
        for r in proposal["rows"]
        if r["pairing"] == "same_signal"
    }
    # DIN 4 red -> 15, 6 green -> 11, 2 blue -> 7, 1 sync -> 20, audio 9 -> 3, 5 -> 1, 7 -> 4.
    assert paired == {
        "1": ["20"],
        "2": ["7"],
        "4": ["15"],
        "5": ["1"],
        "6": ["11"],
        "7": ["4"],
        "9": ["3"],
        "shell": ["shell"],
    }
    # Video ground is on two monitor contacts: a question, never a silent choice.
    ground = rows["from-3"]
    assert ground["to_contact_ids"] == [] and ground["question"]["kind"] == "several_destinations"
    assert [o["contact_id"] for o in ground["question"]["options"]] == ["5", "17"]
    # The supply has no accepting contact at the monitor: must not connect.
    supply = rows["from-8"]
    assert supply["requirement"] == "must_not_connect" and supply["to_contact_ids"] == []
    # Blanking exists only at the monitor: optional and unpaired, with its reason.
    blanking = rows["to-16"]
    assert (blanking["requirement"], blanking["pairing"]) == ("optional", "unpaired")
    # Video declared 75 ohm at both ends: coax 75 ohm, its screen as return.
    red = rows["from-4"]
    assert red["conductor"]["kind"] == "coax" and red["conductor"]["impedance_ohm"] == 75
    assert red["return_policy"] == "dedicated_screen"
    # Sync has no declared impedance: conductor stays unknown, the series part is carried.
    sync = rows["from-1"]
    assert sync["conductor"]["kind"] == "unknown"
    assert [(p["conditioning"], p["value"]) for p in sync["required_parts"]] == [
        ("series_resistor", "470 ohm")
    ]
    assert rows["from-7"]["return_policy"] == "not_applicable"
    assert proposal["open_questions"] == 1


def test_variant_b_power_pin_is_must_not_connect(users, ends):
    rows = by_row(propose(users["viewer"], ends["console_b"], ends["monitor"]))
    first = rows["from-1"]
    assert first["requirement"] == "must_not_connect"
    assert first["basis"] == "Supply output; never wire to a signal input"


def test_unselected_condition_is_a_question_naming_the_hazard(users, ends):
    rows = by_row(propose(users["viewer"], ends["regional"], ends["sink"]))
    first = rows["from-1"]
    assert first["question"]["kind"] == "conditional_pin"
    assert "may carry a supply" in first["question"]["text"]
    assert [o["contact_id"] for o in first["question"]["options"]] == ["20"]


def test_equal_names_in_another_signal_set_are_only_a_question(users, project, ends):
    owner = users["owner"]
    other = frozen(owner, project, examples.av_signal_set(), "Another AV signal set")
    sink = frozen(owner, project, examples.rgb_pinout(other, ends["rgb"], "sink"), "RGB other")
    rows = by_row(propose(users["viewer"], ends["variants"]["Console A AV"], sink))
    red = rows["from-4"]
    assert red["to_contact_ids"] == [] and red["question"]["kind"] == "name_and_type_only"
    assert not [r for r in rows.values() if r["pairing"] == "same_signal"]


def answered(proposal):
    rows = []
    for row in copy.deepcopy(proposal["rows"]):
        if row["question"]:
            row["to_contact_ids"] = [o["contact_id"] for o in row["question"]["options"]]
            row["question"] = None
            row["pairing"] = "answered"
            row["basis"] = "Synthetic reviewer answer"
        rows.append(row)
    return rows


def intent(proposal, ends, **extra):
    return {
        "kind": "cable_intent",
        "from_revision_id": ends["console_a"],
        "to_revision_id": ends["monitor"],
        "rows": proposal["rows"],
        **extra,
    }


def test_open_questions_block_freezing_until_answered(users, project, ends):
    owner = users["owner"]
    proposal = propose(owner, ends["console_a"], ends["monitor"])
    draft = create(owner, project, intent(proposal, ends), "Console A to monitor")
    with pytest.raises(ValidationFailed, match="open intent questions"):
        freeze(owner, draft)
    value = intent(proposal, ends, rows=answered(proposal), isolation="no_unlisted_connections")
    updated = op(
        owner,
        "interface.update",
        {"draft_id": draft["draft_id"], "interface": value},
        expected_state=draft["state"],
    )
    revision = freeze(owner, updated)["revision_id"]
    view = op(users["viewer"], "interface.read", {"revision_id": revision})["intent"]
    ground = next(r for r in view["rows"] if r["row_id"] == "from-3")
    assert ground["to_labels"] == ["5 · Video ground", "17 · Video ground"]
    assert ground["from_label"] == "3 · Video ground" and ground["signal"]["name"] == "Video ground"
    assert view["from"]["device_label"] == "Console A AV out"
    assert view["check"]["status"] == "not_evaluated"
    assert view["open_questions"] == 0


def test_rows_are_checked_against_the_pinned_ends(users, project, ends):
    owner = users["owner"]
    proposal = propose(owner, ends["console_a"], ends["monitor"])
    bad = intent(proposal, ends)
    bad["rows"][0]["to_contact_ids"] = ["99"]
    with pytest.raises(ValidationFailed, match="to-contact"):
        create(owner, project, bad)
    wrong_end = intent(proposal, ends, from_revision_id=ends["signals"])
    with pytest.raises(ValidationFailed, match="port or a pinout"):
        create(owner, project, wrong_end)
    with pytest.raises(NotFound):
        propose(users["outsider"], ends["console_a"], ends["monitor"])


def test_a_cable_pins_its_intent_without_a_check_result(users, project, ends):
    from .test_cable_end_stacks import make_cable
    from .test_interface_conventions import frozen_stock

    owner = users["owner"]
    proposal = propose(owner, ends["console_a"], ends["monitor"])
    revision = freeze(
        owner, create(owner, project, intent(proposal, ends, rows=answered(proposal)))
    )["revision_id"]
    stock = frozen_stock(owner, project)
    stack = {
        "layers": [
            {
                "kind": "connector",
                "layer_id": "connector",
                "body_revision_id": ends["rgb"],
                "pinout_revision_id": ends["sink"],
            }
        ]
    }
    cable = {
        "schema_version": "0.2",
        "stock_revision_id": stock,
        "intent_revision_id": revision,
        "endpoints": [{"local_id": "a", "stack": stack}, {"local_id": "b", "stack": stack}],
    }
    inspected = op(
        owner, "cable.read", {"revision_id": make_cable(owner, project, cable)[1]["revision_id"]}
    )
    assert inspected["intent"]["revision_id"] == revision
    assert inspected["intent"]["check"] == "not_evaluated"
    cable["intent_revision_id"] = ends["monitor"]
    with pytest.raises(ValidationFailed, match="intent"):
        make_cable(owner, project, cable)
