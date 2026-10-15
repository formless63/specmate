"""Check a cable against its intent: per-row paths and separate dimensions.

Expected outcomes are derived by hand from the synthetic tables in
``interfaces.examples`` (DIN_SHARED, RGB_PINS, ADAPTER_PADS, DEMO_CENTRES/SCREENS and the
port facts), not read back from the implementation:

- video rows (DIN 2/4/6 -> RGB 7/15/11) pass: coax centres, 75 ohm stock, 0.7 Vpp both
  ends, each screen lands on video ground at both ends;
- sync (1 -> 20) is unknown: the console declares no sync level (unknown is never pass),
  while its 470 ohm part is found on the board path;
- audio (5 -> 1, 9 -> 3) is unknown: no levels are declared;
- the grounds (3 -> 5+17, 7 -> 4) pass; +5 V (8) must not connect and is not wired;
- chassis and blanking are optional and not wired.
"""

import json

import pytest

from specmate.interfaces import examples

from .conftest import op
from .test_cable_end_stacks import make_cable, part
from .test_interface_conventions import frozen_stock
from .test_interface_ports import frozen


@pytest.fixture
def demo(users, project):
    owner = users["owner"]
    signals = frozen(owner, project, examples.av_signal_set(), "Workshop AV signals")
    din = frozen(owner, project, examples.round_din_10_socket(), "10-pin round DIN socket")
    rgb = frozen(owner, project, examples.rgb_21_socket(), "21-pin RGB socket")
    console = frozen(
        owner, project, examples.console_pinout(signals, din, "Console A AV"), "Console A AV"
    )
    sink = frozen(owner, project, examples.rgb_pinout(signals, rgb, "sink"), "RGB input")
    port = frozen(
        owner, project, examples.console_port(console, "Console A AV out"), "Console A AV out"
    )
    monitor = frozen(owner, project, examples.rgb_monitor_port(sink), "RGB monitor input")
    plug = frozen(owner, project, examples.round_din_10_plug(din), "10-pin round DIN plug")
    rgb_plug = frozen(owner, project, examples.rgb_21_plug(rgb), "21-pin RGB plug")
    plug_variant = frozen(
        owner, project, examples.console_pinout(signals, plug, "Console A AV"), "Plug A"
    )
    rgb_variant = frozen(owner, project, examples.rgb_pinout(signals, rgb_plug, "sink"), "RGB in")
    board = frozen(owner, project, examples.av_adapter_board(plug), "AV adapter board")
    stock = frozen_stock(owner, project)
    frozen(owner, project, examples.av_coax_convention(signals, stock), "Six-coax convention")
    end_a = frozen(
        owner,
        project,
        examples.din_adapter_end(board, plug, plug_variant, part(owner, project, "Shell")),
        "Board end",
    )
    end_b = frozen(
        owner,
        project,
        examples.rgb_inline_end(rgb_plug, rgb_variant, part(owner, project, "Hood")),
        "Inline end",
    )
    proposal = op(
        owner, "cable_intent.propose", {"from_revision_id": port, "to_revision_id": monitor}
    )
    intent = frozen(
        owner,
        project,
        examples.console_to_monitor_intent(port, monitor, proposal["rows"]),
        "Console A to monitor",
    )
    return {
        "stock": stock,
        "end_a": end_a,
        "end_b": end_b,
        "intent": intent,
        "plug": plug,
        "plug_variant": plug_variant,
    }


def check_of(users, project, demo, builder):
    cable = builder(demo["stock"], demo["end_a"], demo["end_b"])
    cable["intent_revision_id"] = demo["intent"]
    revision = make_cable(users["owner"], project, cable)[1]["revision_id"]
    return op(users["viewer"], "cable_intent.check", {"cable_revision_id": revision})


def outcomes(result):
    return {r["row_id"]: r["outcome"] for r in result["rows"]}


CORRECT = {
    "from-1": "unknown",
    "from-2": "pass",
    "from-3": "pass",
    "from-4": "pass",
    "from-5": "unknown",
    "from-6": "pass",
    "from-7": "pass",
    "from-8": "pass",
    "from-9": "unknown",
    "from-shell": "not_evaluated",
    "to-16": "not_evaluated",
}


def test_correct_cable(users, project, demo):
    result = check_of(users, project, demo, examples.av_demo_cable)
    assert outcomes(result) == CORRECT
    rows = {r["row_id"]: r for r in result["rows"]}
    red = rows["from-4"]["dimensions"]
    assert {k: v["status"] for k, v in red.items()} == {
        "connection": "pass",
        "signal_match": "pass",
        "conductor": "pass",
        "level": "pass",
        "required_parts": "not_evaluated",
        "return": "pass",
        "isolation": "pass",
        "shield": "not_evaluated",
        "convention": "pass",
        "mating": "pass",
    }
    labels = [chip["label"] for chip in rows["from-4"]["path"]]
    assert labels[0] == "Console A AV out 4 · Red video" and labels[-1].endswith("15 · Red video")
    assert "Straight copper" in labels and "landing" in labels
    sync = rows["from-1"]["dimensions"]
    assert sync["required_parts"]["status"] == "pass"
    assert "R1 470R" in sync["required_parts"]["reason"]
    assert sync["level"]["status"] == "unknown"
    assert sorted(rows["from-3"]["reached"]) == ["17 · Video ground", "5 · Video ground"]
    assert result["cable"]["isolation"]["status"] == "pass"
    assert result["cable"]["shield"]["status"] == "not_evaluated"
    assert result["ends"]["from"]["endpoint_id"] == "a"
    assert result["continuity"] == "not_evaluated"


def test_swapped_red_and_blue_fail_and_flag_the_convention(users, project, demo):
    result = check_of(users, project, demo, examples.av_swapped_cable)
    assert outcomes(result) == {**CORRECT, "from-2": "fail", "from-4": "fail"}
    red = {r["row_id"]: r for r in result["rows"]}["from-4"]["dimensions"]
    assert red["connection"]["status"] == "fail"
    assert red["signal_match"]["reason"] == "Reaches 7 · Blue video."
    assert red["isolation"]["status"] == "fail"
    # The red row now runs on the core the convention keeps for blue: a flag, nothing more.
    assert red["convention"]["status"] == "flagged"


def test_missing_resistor_fails_required_parts(users, project, demo):
    result = check_of(users, project, demo, examples.av_missing_resistor_cable)
    assert outcomes(result) == {**CORRECT, "from-1": "fail"}
    sync = {r["row_id"]: r for r in result["rows"]}["from-1"]["dimensions"]
    assert sync["connection"]["status"] == "pass"
    assert sync["required_parts"]["status"] == "fail"


def test_power_to_sync_fails_must_not_connect_and_the_sync_row(users, project, demo):
    result = check_of(users, project, demo, examples.av_power_to_sync_cable)
    assert outcomes(result) == {**CORRECT, "from-1": "fail", "from-8": "fail"}
    rows = {r["row_id"]: r for r in result["rows"]}
    assert "20 · Composite sync" in rows["from-8"]["dimensions"]["connection"]["reason"]
    assert rows["from-1"]["dimensions"]["connection"]["reason"] == "The pin reaches no conductor."


def test_draft_check_and_recording_as_evidence(users, project, demo):
    owner = users["owner"]
    cable = examples.av_demo_cable(demo["stock"], demo["end_a"], demo["end_b"])
    draft = op(
        owner,
        "cable.create",
        {"workspace_id": None, "name": "Draft cable", "cable": cable},
    )
    result = op(
        users["viewer"],
        "cable_intent.check",
        {"draft_id": draft["draft_id"], "intent_revision_id": demo["intent"]},
    )
    assert result["draft_id"] == draft["draft_id"] and outcomes(result) == CORRECT
    frozen_cable = op(
        owner, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )["revision_id"]
    record = op(
        owner,
        "evidence.record_cable_intent_check",
        {"cable_revision_id": frozen_cable, "intent_revision_id": demo["intent"]},
        idempotency_key="record-check-1",
    )
    assert record["source"] == "cable_intent_check"
    roles = {(p["role"], str(p["revision_id"])) for p in record["pins"]}
    assert ("cable", frozen_cable) in roles and ("intent", demo["intent"]) in roles
    assert outcomes(record["result"]) == CORRECT
    read = op(users["viewer"], "evidence.read_recorded", {"record_id": record["record_id"]})
    assert read["stale"] is False
    # The recorded check is listed with the rest of the workspace's evidence.
    listed = op(users["viewer"], "evidence.list", {"workspace_id": record["workspace_id"]})
    assert "cable_intent_check" in json.dumps(listed, default=str)
    applicable = op(
        users["viewer"],
        "evidence.applicability",
        {"workspace_id": record["workspace_id"], "revision_id": frozen_cable},
    )
    assert "cable_intent_check" in json.dumps(applicable, default=str)


def test_search_limit_reads_unknown(users, project, demo, monkeypatch):
    from specmate.cables import intent_check

    monkeypatch.setattr(intent_check, "MAX_PATHS", 1)
    result = check_of(users, project, demo, examples.av_demo_cable)
    ground = {r["row_id"]: r for r in result["rows"]}["from-3"]["dimensions"]["connection"]
    # Video ground fans out over four screens; one path is not the whole answer.
    assert ground["status"] == "unknown"
    assert ground["reason"].startswith("search limit reached")


def test_wired_destination_without_a_source_is_flagged_and_its_short_fails(users, project, demo):
    def blanking_on_audio_screen(stock, end_a, end_b):
        cable = examples.av_demo_cable(stock, end_a, end_b)
        # The grey screen also feeds the blanking resistor: blanking joins audio ground.
        for assignment in cable["assignments"]:
            if (assignment["endpoint_id"], assignment["element_path"]) == (
                "b",
                "stock.core-6.screen",
            ):
                assignment.update(layer_id="inline", terminal_id="r1.1")
        return cable

    result = check_of(users, project, demo, blanking_on_audio_screen)
    rows = {r["row_id"]: r for r in result["rows"]}
    blanking = rows["to-16"]["dimensions"]
    assert blanking["connection"] == {
        "status": "flagged",
        "reason": "wired outside the intent",
        "evidence": ["declared topology"],
    }
    assert blanking["isolation"]["status"] == "fail" and "from-7" in blanking["isolation"]["reason"]
    assert rows["to-16"]["outcome"] == "fail"
    ground = rows["from-7"]["dimensions"]["isolation"]
    assert ground["status"] == "fail" and "16 · RGB blanking" in ground["reason"]
