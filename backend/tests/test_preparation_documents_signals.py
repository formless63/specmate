"""PRE-004 documents name what each termination carries (CAB-006 proposed, phase 9).

Expected values come from the synthetic tables in ``interfaces.examples``: the red core
(``stock.core-1.center``) lands on the board's R pad, which reaches plug contact 4 (Red
video); the sync core lands on the CS pad, whose board path carries the 470 R resistor;
at the monitor end it lands directly on RGB contact 15 (Red video).
"""

import json

from specmate.interfaces import examples

from . import test_cable_intent_check
from .conftest import op
from .scope_helpers import workspace_of
from .test_cable_end_stacks import make_cable
from .test_cable_test_intent import freeze as freeze_tests
from .test_preparation_documents import configuration, files, retain

demo = test_cable_intent_check.demo


def test_build_sheet_and_terminations_show_signals_parts_and_test_labels(users, project, demo):
    owner = users["owner"]
    cable = examples.av_demo_cable(demo["stock"], demo["end_a"], demo["end_b"])
    cable["intent_revision_id"] = demo["intent"]
    root = make_cable(owner, project, cable)[1]
    proposal = op(
        owner,
        "cable_test_plan.derive_from_intent",
        {"root_revision_id": root["revision_id"], "cable_revision_id": root["revision_id"]},
    )
    plan = op(
        owner,
        "cable_test_plan.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Reviewed bench plan",
            "test_plan": proposal["test_plan"],
        },
    )
    tests = freeze_tests(owner, plan)
    config = configuration(
        root, quantity=1, bindings=[{"test_plan_revision_id": tests["revision_id"]}]
    )
    _, saved = retain(owner, config, key="signal-documents")
    data = files(users["viewer"], saved)

    terminations = json.loads(data["terminations.json"])["declarations"][0]
    rows = {(r["endpoint_id"], r["element_path"]): r for r in terminations["rows"]}
    red_a = rows[("a", "stock.core-1.center")]
    assert red_a["layer_kind"] == "board" and red_a["target_label"] == "R"
    assert red_a["contacts"][0]["signal"] == {"name": "Red video", "type": "analog_video"}
    assert red_a["stock_end"] == "a"
    sync_a = rows[("a", "stock.core-4.center")]
    assert any("470" in note for note in sync_a["part_notes"])
    red_b = rows[("b", "stock.core-1.center")]
    assert red_b["layer_kind"] == "connector" and red_b["contacts"][0]["contact_id"] == "15"
    assert red_b["contacts"][0]["signal"]["name"] == "Red video"

    sheet = data["build-sheet.html"].decode()
    assert "Terminations by end" in sheet
    assert "Red video (analog video)" in sheet
    assert "stock end a" in sheet and "stock end b" in sheet
    assert "Test expectations and labels" in sheet
    assert "470 ohm" in sheet
    assert "15 · Red video" in sheet
