"""Library home: attention from existing records, recent work and card previews (LIB-005).

Expectations come from the synthetic tables in ``interfaces.examples`` as already derived
by hand in test_cable_intent_check (swapped red/blue fails two rows; sync and the two
audio rows are unknown) and test_cable_intent (one ground row asks a question).
"""

import copy

import pytest

from specmate.design.models import Draft
from specmate.interfaces import examples
from specmate.operations import NotFound, ValidationFailed

from .conftest import op
from .test_cable_end_stacks import make_cable
from .test_cable_intent import ends, intent, propose  # noqa: F401
from .test_cable_intent_check import demo  # noqa: F401
from .test_interface_ports import av, create  # noqa: F401
from .test_project_references import part
from .test_transports import api, post_op


def home(user, **payload):
    return op(user, "library.home", payload)


def previews(user, ids, **payload):
    return op(user, "library.previews", {"definition_ids": ids, **payload})


def attention_of(page, label):
    return next(item for item in page["attention"] if item["label"] == label)


def test_open_questions_and_unknown_values_need_attention(users, project, workspace, ends):  # noqa: F811
    owner = users["owner"]
    proposal = propose(owner, ends["console_a"], ends["monitor"])
    create(owner, project, intent(proposal, ends), "Console A to monitor")
    page = home(users["viewer"])
    assert page["workspace_id"] == workspace
    item = attention_of(page, "Console A to monitor")
    questions = next(r for r in item["reasons"] if r["kind"] == "open_questions")
    assert questions == {"kind": "open_questions", "count": 1, "detail": "1 open question"}
    assert item["status"] == "review" and item["latest_revision"] is None
    # The monitor port declares the sync pin's level and impedance as unknown.
    monitor = attention_of(page, "RGB monitor 21-pin input")
    unknown = next(r for r in monitor["reasons"] if r["kind"] == "unknown_values")
    assert unknown["count"] >= 2 and monitor["status"] == "unknown"
    assert page["totals"]["open_questions"] == 1
    assert page["totals"]["failing_checks"] == 0 and page["totals"]["stale_evidence"] == 0
    # Review comes before unknown values; the intent is listed ahead of the ports.
    labels = [row["label"] for row in page["attention"]]
    assert labels.index("Console A to monitor") < labels.index("RGB monitor 21-pin input")
    assert page["attention_total"] >= len(page["attention"]) and not page["scan_limit_reached"]


def test_failing_recorded_check_comes_first_and_goes_stale(users, project, demo):  # noqa: F811
    owner = users["owner"]
    cable = examples.av_swapped_cable(demo["stock"], demo["end_a"], demo["end_b"])
    cable["intent_revision_id"] = demo["intent"]
    draft, frozen = make_cable(owner, project, cable, name="Swapped cable")
    # Checking alone records nothing, so nothing needs attention yet.
    op(users["viewer"], "cable_intent.check", {"cable_revision_id": frozen["revision_id"]})
    assert all(item["label"] != "Swapped cable" for item in home(users["viewer"])["attention"])
    op(
        owner,
        "evidence.record_cable_intent_check",
        {"cable_revision_id": frozen["revision_id"], "intent_revision_id": demo["intent"]},
    )
    page = home(users["viewer"])
    first = page["attention"][0]
    assert first["label"] == "Swapped cable" and first["status"] == "fail"
    assert [(r["kind"], r["count"], r["detail"]) for r in first["reasons"]] == [
        ("failing_check", 2, "2 rows fail"),
        ("unknown_check", 3, "3 rows unknown"),
    ]
    assert first["latest_revision"] == 1
    assert page["totals"]["failing_checks"] == 2 and page["totals"]["unknown_checks"] == 3
    # A newer cable revision makes the latest record stale; the record itself is unchanged.
    changed = copy.deepcopy(cable)
    changed["review_basis"] = "Rechecked against a new drawing"
    state = Draft.objects.get(id=draft["draft_id"]).state_token
    updated = op(
        owner,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": changed},
        expected_state=state,
    )
    op(owner, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=updated["state"])
    stale = attention_of(home(users["viewer"]), "Swapped cable")
    assert stale["latest_revision"] == 2
    assert [r["kind"] for r in stale["reasons"]] == [
        "failing_check",
        "stale_evidence",
        "unknown_check",
    ]


def test_recent_lists_only_the_actors_own_work_newest_first(users, workspace):
    first = part(users["editor"], workspace, "First part")
    part(users["contributor"], workspace, "Someone else's part")
    second = part(users["editor"], workspace, "Second part", freeze=True)
    recent = home(users["editor"])["recent"]
    assert [(r["label"], r["activity"]) for r in recent] == [
        ("Second part", "frozen"),
        ("First part", "edited"),
    ]
    assert recent[0]["latest_revision_id"] == second["revision_id"]
    assert recent[1]["record_id"] == first["definition_id"]
    assert home(users["viewer"])["recent"] == []
    page = home(users["viewer"], limit=1)
    assert {"kind": "part", "count": 3} in page["kinds"] and page["definitions_total"] == 3


def test_home_and_previews_stay_inside_the_workspace(users, workspace, other_workspace):
    ours = part(users["owner"], workspace, "Our part", freeze=True)
    theirs = op(
        users["outsider"],
        "definition.create",
        {"workspace_id": other_workspace, "kind": "part", "name": "Foreign part"},
    )
    with pytest.raises(NotFound):
        home(users["outsider"], workspace_id=workspace)
    assert home(users["outsider"])["definitions_total"] == 1
    # Foreign ids are left out silently: the result is the same as for a missing id.
    page = previews(users["viewer"], [ours["definition_id"], theirs["definition_id"]])
    assert [p["record_id"] for p in page["previews"]] == [ours["definition_id"]]
    preview = page["previews"][0]
    assert preview["source"] == "revision" and preview["revision"] == 1
    assert preview["content"] == {} and not preview["truncated"] and preview["stock"] is None
    with pytest.raises(NotFound):
        previews(users["outsider"], [ours["definition_id"]], workspace_id=workspace)
    with pytest.raises(ValidationFailed):
        previews(users["viewer"], [])


def test_previews_are_frozen_first_and_resolve_a_cables_stock(users, project, workspace, demo):  # noqa: F811
    owner = users["owner"]
    cable = examples.av_demo_cable(demo["stock"], demo["end_a"], demo["end_b"])
    draft, _ = make_cable(owner, project, cable, name="Demo cable")
    unfrozen = op(
        owner,
        "definition.create",
        {"workspace_id": workspace, "kind": "part", "name": "Loose part"},
    )
    ids = [unfrozen["definition_id"], draft["definition_id"]]
    page = previews(users["viewer"], ids)
    assert [p["record_id"] for p in page["previews"]] == ids
    loose, made = page["previews"]
    assert loose["source"] == "draft" and loose["revision"] is None
    assert made["source"] == "revision" and made["kind"] == "cable"
    assert made["content"]["cable"]["stock_revision_id"] == demo["stock"]
    assert made["stock"]["structure"]["kind"] == "group"


def test_api_entry_point_is_the_same_read_only_operation(users, workspace):
    part(users["owner"], workspace, "Listed part")
    response = post_op(api(users["viewer"]), "library.home", {})
    assert response.status_code == 200
    body = response.json()
    assert body["operation"] == "library.home" and body["result"]["definitions_total"] == 1
    assert post_op(api(), "library.home", {}).status_code in (401, 403)
