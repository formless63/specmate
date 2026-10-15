"""INT-001/LIB-001: signal sets, typed pin signals and named pinout variants."""

import copy
import json

import pytest
from django.test import Client

from specmate.design.models import Draft
from specmate.interfaces import examples
from specmate.interfaces.queries import inspect_revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import ensure_member, op
from .scope_helpers import workspace_of


def create(user, scope, interface, name="Synthetic interface", **ctx):
    return op(
        user,
        "interface.create",
        {"workspace_id": workspace_of(scope), "name": name, "interface": interface},
        **ctx,
    )


def freeze(user, draft, **ctx):
    return op(
        user,
        "interface.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def frozen(user, scope, interface, name="Synthetic interface"):
    return freeze(user, create(user, scope, interface, name))


@pytest.fixture
def av(users, project):
    owner = users["owner"]
    signals = frozen(owner, project, examples.av_signal_set(), "Workshop AV signals")
    din = frozen(owner, project, examples.round_din_10_socket(), "10-pin round DIN socket")
    rgb = frozen(owner, project, examples.rgb_21_socket(), "21-pin RGB socket")
    return {"signals": signals["revision_id"], "din": din["revision_id"], "rgb": rgb["revision_id"]}


def test_signal_set_keeps_types_returns_and_unknown_levels(users, project, av):
    view = inspect_revision(users["viewer"], av["signals"])
    signals = {s["key"]: s for s in view["interface"]["signals"]}
    assert signals["video_red"]["type"] == "analog_video"
    assert signals["video_red"]["level"] == {
        "status": "known",
        "nominal": 0.7,
        "minimum": None,
        "maximum": None,
        "basis": examples.BASIS,
        "unit": "Vpp",
    }
    assert signals["video_red"]["impedance"]["nominal"] == 75
    # Unknown stays unknown: no value, no unit, never zero.
    assert signals["composite_sync"]["level"]["status"] == "unknown"
    assert signals["composite_sync"]["level"]["nominal"] is None
    assert signals["composite_sync"]["impedance"]["status"] == "unknown"
    assert signals["video_ground"]["return_for"] == [
        "video_red",
        "video_green",
        "video_blue",
        "composite_sync",
    ]
    assert view["compatibility"] == "not_evaluated"


def _signals(**changes):
    value = examples.av_signal_set()
    for key, patch in changes.items():
        for signal in value["signals"]:
            if signal["key"] == key:
                signal.update(patch)
    return value


@pytest.mark.parametrize(
    "value",
    [
        _signals(video_green={"key": "video_red"}),
        _signals(video_green={"name": "red VIDEO"}),
        _signals(video_red={"return_for": ["video_blue"]}),
        _signals(audio_ground={"return_for": ["video_ground"]}),
        _signals(audio_ground={"return_for": ["nothing"]}),
        _signals(video_red={"level": {"status": "known", "nominal": 0.7, "unit": "Vpp"}}),
        _signals(video_red={"level": {"status": "unknown", "nominal": 0.7}}),
        _signals(video_red={"level": {"status": "known", "nominal": 1, "basis": "x"}}),
        _signals(video_red={"impedance": {"status": "known", "nominal": 0, "basis": "x"}}),
        _signals(audio_left={"differential_with": "audio_left"}),
        _signals(
            audio_left={"differential_with": "audio_right"},
            audio_right={"differential_with": "video_red"},
        ),
        _signals(video_red={"type": "television"}),
    ],
)
def test_invalid_signal_sets_are_rejected(users, project, value):
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, value)


def test_named_variants_on_one_body_differ_on_pin_1_and_list_together(users, project, av):
    owner = users["owner"]
    variants = {
        label: frozen(
            owner,
            project,
            examples.console_pinout(av["signals"], av["din"], label),
            f"10-pin socket {label}",
        )
        for label in ("Console A AV", "Console B AV")
    }
    views = {k: inspect_revision(owner, v["revision_id"]) for k, v in variants.items()}
    pin_1 = {k: v["signals"]["1"]["signal"] for k, v in views.items()}
    assert pin_1["Console A AV"]["name"] == "Composite sync"
    assert pin_1["Console A AV"]["type"] == "sync"
    assert pin_1["Console B AV"]["name"] == "+9 V"
    assert pin_1["Console B AV"]["type"] == "power"
    for contact in ("2", "3", "8", "shell"):
        a, b = (views[k]["signals"][contact] for k in ("Console A AV", "Console B AV"))
        assert a == b
    # Contact 10 has no assignment: no signal is implied.
    assert "10" not in views["Console A AV"]["signals"]
    assert all(v["compatibility"] == "not_evaluated" for v in views.values())
    # The body lists its named variants together; nothing claims they are interchangeable.
    body = inspect_revision(users["viewer"], av["din"])
    assert [(v["variant_label"], v["role"]) for v in body["pinout_variants"]] == [
        ("Console A AV", "source"),
        ("Console B AV", "source"),
    ]
    assert all(v["same_body_revision"] for v in body["pinout_variants"])
    assert body["compatibility"] == "not_evaluated"
    # Another body lists none of them.
    assert inspect_revision(owner, av["rgb"])["pinout_variants"] == []


def test_rgb_sink_and_source_variants_share_one_body(users, project, av):
    owner = users["owner"]
    for role in ("sink", "source"):
        frozen(owner, project, examples.rgb_pinout(av["signals"], av["rgb"], role), f"RGB {role}")
    body = inspect_revision(owner, av["rgb"])
    assert [(v["variant_label"], v["role"], v["standard"]) for v in body["pinout_variants"]] == [
        ("RGB input", "sink", "Synthetic 21-pin RGB"),
        ("RGB output", "source", "Synthetic 21-pin RGB"),
    ]


def test_variants_of_an_earlier_body_revision_stay_listed_with_their_pin(users, project, av):
    owner = users["owner"]
    body_draft = create(owner, project, examples.round_din_10_socket(), "Revised socket")
    first_body = freeze(owner, body_draft)
    value = examples.console_pinout(av["signals"], first_body["revision_id"], "Console A AV")
    first = frozen(owner, project, value)
    revised = examples.round_din_10_socket()
    revised["family"] = "10-pin round DIN, revised drawing"
    current = Draft.objects.get(id=body_draft["draft_id"]).state_token
    state = op(
        owner,
        "interface.update",
        {"draft_id": body_draft["draft_id"], "interface": revised},
        expected_state=current,
    )
    newer = freeze(owner, {**body_draft, **state})
    assert newer["revision_id"] != first_body["revision_id"]
    listed = inspect_revision(owner, newer["revision_id"])["pinout_variants"]
    assert [(v["revision_id"], v["same_body_revision"]) for v in listed] == [
        (first["revision_id"], False)
    ]


def _pinout(av, contact="1", key="composite_sync", role="signal", **extra):
    return {
        "kind": "pinout",
        "body_revision_id": av["din"],
        "assignments": [
            {
                "contact_id": contact,
                "electrical": {
                    "signal_ref": {"signal_set_revision_id": av["signals"], "key": key},
                    "role": role,
                },
            }
        ],
        **extra,
    }


@pytest.mark.parametrize(
    "key,role",
    [
        ("video_ground", "power"),  # a return on a power role
        ("power_9v", "signal"),
        ("video_red", "unused"),
        ("chassis", "return"),
    ],
)
def test_pin_role_must_fit_the_signal_type(users, project, av, key, role):
    with pytest.raises(ValidationFailed, match="cannot carry"):
        create(users["owner"], project, _pinout(av, key=key, role=role))


def test_unknown_role_accepts_any_signal_and_unknown_key_is_rejected(users, project, av):
    draft = create(users["owner"], project, _pinout(av, key="video_ground", role="unknown"))
    assert draft["draft_id"]
    with pytest.raises(ValidationFailed, match="not declared"):
        create(users["owner"], project, _pinout(av, key="video_purple"))
    not_a_set = _pinout(av)
    not_a_set["assignments"][0]["electrical"]["signal_ref"]["signal_set_revision_id"] = av["rgb"]
    with pytest.raises(ValidationFailed, match="signal set revision"):
        create(users["owner"], project, not_a_set)


def test_signal_set_from_another_workspace_reads_not_found(users, project, av, other_workspace):
    outsider = users["outsider"]
    foreign = frozen(outsider, other_workspace, examples.av_signal_set(), "Foreign AV")
    value = _pinout(av)
    value["assignments"][0]["electrical"]["signal_ref"]["signal_set_revision_id"] = foreign[
        "revision_id"
    ]
    # Even an actor who belongs to both workspaces cannot pin across them.
    ensure_member(users["owner"], "admin", workspace=other_workspace)
    with pytest.raises(NotFound):
        create(users["owner"], project, value)
    with pytest.raises(NotFound):
        inspect_revision(outsider, av["signals"])


def test_equal_names_in_two_sets_are_different_signals(users, project, av):
    owner = users["owner"]
    other = frozen(owner, project, examples.av_signal_set(), "Second AV signals")
    value = _pinout(av, contact="4", key="video_red")
    value["assignments"].append(
        {
            "contact_id": "6",
            "electrical": {
                "signal_ref": {"signal_set_revision_id": other["revision_id"], "key": "video_red"},
                "role": "signal",
            },
        }
    )
    pins = frozen(owner, project, value)
    signals = inspect_revision(owner, pins["revision_id"])["signals"]
    assert signals["4"]["signal"]["name"] == signals["6"]["signal"]["name"] == "Red video"
    assert signals["4"]["signal"]["signal_set_revision_id"] == av["signals"]
    assert signals["6"]["signal"]["signal_set_revision_id"] == other["revision_id"]
    assert signals["4"]["signal"]["set_name"] == "Workshop AV signals"
    assert signals["6"]["signal"]["set_name"] == "Second AV signals"


def _conditional(av, **patch):
    value = {
        "kind": "pinout",
        "body_revision_id": av["din"],
        "variant_label": "Console AV (regional)",
        "role": "source",
        "conditions": [
            {
                "key": "region",
                "name": "Console region",
                "choices": [{"key": "a", "name": "Region A"}, {"key": "b", "name": "Region B"}],
            }
        ],
        "assignments": [
            {
                "contact_id": "1",
                "alternatives": [
                    {
                        "condition_key": "region",
                        "choice": "a",
                        "signal_ref": {
                            "signal_set_revision_id": av["signals"],
                            "key": "composite_sync",
                        },
                        "role": "signal",
                        "basis": "Synthetic pin table",
                    },
                    {
                        "condition_key": "region",
                        "choice": "b",
                        "signal_ref": {"signal_set_revision_id": av["signals"], "key": "power_9v"},
                        "role": "power",
                        "basis": "Synthetic pin table",
                    },
                ],
            }
        ],
    }
    value.update(patch)
    return value


def test_conditional_pin_is_unknown_until_a_condition_is_selected(users, project, av):
    owner = users["owner"]
    pins = frozen(owner, project, _conditional(av))
    row = inspect_revision(owner, pins["revision_id"])["signals"]["1"]
    assert row["status"] == "conditional"
    assert row["signal"] is None
    assert [(a["choice"], a["signal_ref"]["name"]) for a in row["alternatives"]] == [
        ("a", "Composite sync"),
        ("b", "+9 V"),
    ]


@pytest.mark.parametrize("break_it", ["choice", "condition", "role", "unconditional"])
def test_invalid_conditional_pins_are_rejected(users, project, av, break_it):
    value = _conditional(av)
    alternatives = value["assignments"][0]["alternatives"]
    if break_it == "choice":
        alternatives[1]["choice"] = "c"
    elif break_it == "condition":
        alternatives[1]["condition_key"] = "mode"
    elif break_it == "role":
        alternatives[1]["role"] = "signal"
    else:
        value["assignments"][0]["electrical"] = {
            "signal_ref": {"signal_set_revision_id": av["signals"], "key": "power_9v"}
        }
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, value)


@pytest.mark.parametrize("actor,error", [("viewer", PermissionDenied), ("outsider", NotFound)])
def test_signal_set_authoring_scope(users, project, av, actor, error):
    with pytest.raises(error):
        create(users[actor], project, examples.av_signal_set())
    draft = create(users["owner"], project, examples.av_signal_set())
    with pytest.raises(error):
        op(
            users[actor],
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": examples.av_signal_set()},
            expected_state=draft["state"],
        )


def test_signal_set_stale_edit_conflicts_and_keyed_create_replays(users, project):
    owner = users["owner"]
    first = create(owner, project, examples.av_signal_set(), idempotency_key="signals")
    assert create(owner, project, examples.av_signal_set(), idempotency_key="signals") == first
    changed = examples.av_signal_set()
    changed["description"] = "Changed"
    with pytest.raises(IdempotencyMismatch):
        create(owner, project, changed, idempotency_key="signals")
    updated = op(
        owner,
        "interface.update",
        {"draft_id": first["draft_id"], "interface": changed},
        expected_state=first["state"],
    )
    with pytest.raises(Conflict):
        op(
            owner,
            "interface.update",
            {"draft_id": first["draft_id"], "interface": examples.av_signal_set()},
            expected_state=first["state"],
        )
    revision = freeze(owner, {**first, **updated})
    view = inspect_revision(owner, revision["revision_id"])
    assert view["interface"]["description"] == "Changed"
    # A frozen set is immutable: the kind cannot change and later edits need a new draft.
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "interface.update",
            {"draft_id": first["draft_id"], "interface": examples.round_din_10_socket()},
            expected_state=updated["state"],
        )


def test_http_entry_point_creates_and_reads_signal_sets(users, project, av):
    client = Client()
    client.force_login(users["contributor"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "interface.create",
                "request_id": "signals-api",
                "payload": {
                    "workspace_id": workspace_of(project),
                    "name": "HTTP AV signals",
                    "interface": copy.deepcopy(examples.av_signal_set()),
                },
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    draft = client.get(f"/api/v0/interfaces/drafts/{response.json()['result']['draft_id']}")
    assert draft.json()["kind"] == "signal_set"
    read = client.get(f"/api/v0/interfaces/revisions/{av['din']}")
    assert read.status_code == 200 and read.json()["pinout_variants"] == []
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/interfaces/revisions/{av['signals']}").status_code == 404
