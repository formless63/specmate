"""INT-001/INT-002: device ports per pinout variant and reviewed connector mating."""

import copy
import json

import pytest
from django.test import Client

from specmate.interfaces import examples
from specmate.interfaces.queries import end_expectations, inspect_revision
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


def freeze(user, draft):
    return op(
        user, "interface.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


def frozen(user, scope, interface, name="Synthetic interface"):
    return freeze(user, create(user, scope, interface, name))["revision_id"]


@pytest.fixture
def av(users, project):
    owner = users["owner"]
    signals = frozen(owner, project, examples.av_signal_set(), "Workshop AV signals")
    din = frozen(owner, project, examples.round_din_10_socket(), "10-pin round DIN socket")
    rgb = frozen(owner, project, examples.rgb_21_socket(), "21-pin RGB socket")
    variants = {
        label: frozen(owner, project, examples.console_pinout(signals, din, label), label)
        for label in ("Console A AV", "Console B AV")
    }
    regional = frozen(
        owner, project, examples.regional_console_pinout(signals, din), "Regional console"
    )
    sink = frozen(owner, project, examples.rgb_pinout(signals, rgb, "sink"), "RGB input")
    return {
        "signals": signals,
        "din": din,
        "rgb": rgb,
        "variants": variants,
        "regional": regional,
        "sink": sink,
    }


def rows(view):
    return {row["contact_id"]: row for row in view["rows"]}


def test_source_and_sink_ports_freeze_with_declared_and_unknown_facts(users, project, av):
    owner = users["owner"]
    port_a = frozen(
        owner,
        project,
        examples.console_port(av["variants"]["Console A AV"], "Console A AV out"),
        "Console A AV out",
    )
    monitor = frozen(
        owner, project, examples.rgb_monitor_port(av["sink"]), "RGB monitor 21-pin input"
    )
    view = inspect_revision(users["viewer"], port_a)
    end = rows(view["end"])
    assert view["end"]["role"] == "source"
    assert view["end"]["variant_label"] == "Console A AV"
    assert end["1"]["status"] == "declared"
    assert end["1"]["signal"]["name"] == "Composite sync"
    assert end["1"]["device"]["needs_in_cable"][0]["conditioning"] == "series_resistor"
    # Declared sync level is absent: it stays unknown, never zero.
    assert end["1"]["device"]["level"] == {
        "status": "unknown",
        "nominal": None,
        "minimum": None,
        "maximum": None,
        "basis": None,
        "unit": "unknown",
    }
    assert end["4"]["device"]["level"]["nominal"] == 0.7
    assert end["4"]["device"]["termination"] == "source_terminated"
    # A contact the port says nothing about has no device facts at all.
    assert end["9"]["device"] is None
    assert end["10"]["status"] == "unknown"
    sink = rows(end_expectations(owner, monitor))
    assert sink["15"]["signal"]["name"] == "Red video"
    assert sink["15"]["device"]["behaviour"] == "accepts"
    assert sink["20"]["device"]["level"]["status"] == "unknown"
    assert sink["20"]["device"]["impedance"]["status"] == "unknown"
    assert view["compatibility"] == "not_evaluated"


def test_variant_b_port_marks_its_supply_pin_must_not_connect(users, project, av):
    owner = users["owner"]
    port_b = frozen(
        owner, project, examples.console_port(av["variants"]["Console B AV"], "Console B AV out")
    )
    pin = rows(end_expectations(owner, port_b))["1"]
    assert pin["signal"]["name"] == "+9 V"
    assert pin["device"]["must_not_connect"] is True
    bad = examples.console_port(av["variants"]["Console B AV"], "Console B AV out")
    bad["pins"][-1]["must_not_connect_reason"] = None
    with pytest.raises(ValidationFailed):
        create(owner, project, bad)


def test_unselected_condition_reports_pin_1_unknown_and_may_be_power(users, project, av):
    owner = users["owner"]
    port = examples.console_port(av["regional"], "Regional console AV out")
    unselected = rows(end_expectations(owner, frozen(owner, project, port)))["1"]
    assert unselected["status"] == "unknown"
    assert unselected["reason"] == "Condition Device region is not selected."
    assert unselected["hazards"] == ["may_be_power"]
    assert [a["signal_ref"]["name"] for a in unselected["alternatives"]] == [
        "Composite sync",
        "+9 V",
    ]
    for choice, name in (("a", "Composite sync"), ("b", "+9 V")):
        chosen = frozen(owner, project, {**port, "selected_conditions": {"region": choice}})
        pin = rows(end_expectations(owner, chosen))["1"]
        assert (pin["status"], pin["signal"]["name"]) == ("declared", name)
    with pytest.raises(ValidationFailed, match="selected condition"):
        create(owner, project, {**port, "selected_conditions": {"region": "c"}})
    with pytest.raises(ValidationFailed, match="selected condition"):
        create(owner, project, {**port, "selected_conditions": {"mode": "a"}})


def test_a_pinout_variant_alone_is_a_valid_end_with_unknown_device_facts(users, project, av):
    end = end_expectations(users["viewer"], av["sink"])
    assert end["kind"] == "pinout"
    assert end["role"] == "sink"
    assert end["device_label"] is None
    assert rows(end)["15"]["signal"]["name"] == "Red video"
    assert all(row["device"] is None for row in end["rows"])
    with pytest.raises(ValidationFailed, match="cable end"):
        end_expectations(users["owner"], av["din"])


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda p, av: p.update(role="sink"), "contradicts"),
        (lambda p, av: p.update(pinout_revision_id=av["din"]), "pinout variant"),
        (lambda p, av: p["pins"].append({"contact_id": "99"}), "contact"),
        (lambda p, av: p["pins"].append(dict(p["pins"][0])), None),
        (lambda p, av: p.update(review="reviewed", review_basis=None), None),
        (lambda p, av: p["pins"][0].update(coupling="maybe"), None),
        (lambda p, av: p["pins"][0].update(level={"status": "known", "nominal": 1}), None),
    ],
)
def test_invalid_ports_are_rejected(users, project, av, mutate, match):
    port = copy.deepcopy(examples.console_port(av["variants"]["Console A AV"], "Console A"))
    mutate(port, av)
    with pytest.raises(ValidationFailed, match=match):
        create(users["owner"], project, port)


def test_reviewed_mating_is_declared_on_the_plug_and_listed_on_the_socket(users, project, av):
    owner = users["owner"]
    plug = frozen(owner, project, examples.round_din_10_plug(av["din"]), "10-pin round DIN plug")
    view = inspect_revision(owner, plug)
    [mate] = view["mates_with"]
    assert (mate["name"], mate["status"], mate["correspondence"]) == (
        "10-pin round DIN socket",
        "reviewed",
        "same_contact_id",
    )
    assert {"this": "shell", "other": "shell"} in mate["pairs"]
    assert len(mate["pairs"]) == 11
    socket = inspect_revision(users["viewer"], av["din"])
    assert [(m["name"], m["status"]) for m in socket["mated_by"]] == [
        ("10-pin round DIN plug", "reviewed")
    ]
    # The plug's own pinouts are not the socket's variants through the mating pin.
    assert {v["variant_label"] for v in socket["pinout_variants"]} == {
        "Console A AV",
        "Console B AV",
        "Console AV (regional)",
    }


def test_unreviewed_mating_is_unknown_and_nothing_is_inferred_from_family(users, project, av):
    owner = users["owner"]
    plug = frozen(owner, project, examples.rgb_21_plug(av["rgb"], review="unreviewed"))
    assert inspect_revision(owner, plug)["mates_with"][0]["status"] == "unknown"
    # Same family, no declaration: no mating at all.
    lone = frozen(owner, project, {**examples.rgb_21_plug(av["rgb"]), "mates_with": []})
    assert inspect_revision(owner, lone)["mates_with"] == []
    assert inspect_revision(owner, av["rgb"])["mated_by"] == [
        {
            "body_revision_id": plug,
            "name": "Synthetic interface",
            "number": 1,
            "declares_revision_id": av["rgb"],
            "correspondence": "same_contact_id",
            "review": "unreviewed",
            "status": "unknown",
        }
    ]


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda b, av: b.update(mating_role="receptacle"), "mating roles"),
        (lambda b, av: b["mates_with"][0].update(body_revision_id=av["sink"]), "connector body"),
        (lambda b, av: b.update(contacts=examples.rgb_21_socket()["contacts"]), "every contact"),
        (
            lambda b, av: b["mates_with"][0].update(
                correspondence="explicit", pairs=[{"this": "1", "other": "99"}]
            ),
            "both bodies",
        ),
        (lambda b, av: b["mates_with"][0].update(correspondence="explicit"), None),
        (lambda b, av: b["mates_with"][0].update(basis=None), None),
        (lambda b, av: b["mates_with"].append(dict(b["mates_with"][0])), None),
    ],
)
def test_invalid_mating_declarations_are_rejected(users, project, av, mutate, match):
    body = copy.deepcopy(examples.round_din_10_plug(av["din"]))
    mutate(body, av)
    with pytest.raises(ValidationFailed, match=match):
        create(users["owner"], project, body)


def test_explicit_correspondence_pairs_named_contacts(users, project, av):
    body = examples.round_din_10_plug(av["din"])
    body["mates_with"][0].update(
        correspondence="explicit", pairs=[{"this": "1", "other": "2"}, {"this": "2", "other": "1"}]
    )
    view = inspect_revision(users["owner"], frozen(users["owner"], project, body))
    assert view["mates_with"][0]["pairs"] == [
        {"this": "1", "other": "2"},
        {"this": "2", "other": "1"},
    ]


def test_ports_and_mating_pins_stay_inside_one_workspace(users, project, av, other_workspace):
    outsider = users["outsider"]
    foreign_body = frozen(outsider, other_workspace, examples.round_din_10_socket())
    ensure_member(users["owner"], "admin", workspace=other_workspace)
    with pytest.raises(NotFound):
        create(users["owner"], project, examples.round_din_10_plug(foreign_body))
    with pytest.raises(NotFound):
        create(
            users["owner"],
            other_workspace,
            examples.console_port(av["variants"]["Console A AV"], "Console A"),
        )
    with pytest.raises(NotFound):
        end_expectations(outsider, av["sink"])


@pytest.mark.parametrize("actor,error", [("viewer", PermissionDenied), ("outsider", NotFound)])
def test_port_authoring_scope(users, project, av, actor, error):
    port = examples.console_port(av["variants"]["Console A AV"], "Console A")
    with pytest.raises(error):
        create(users[actor], project, port)
    draft = create(users["owner"], project, port)
    with pytest.raises(error):
        op(
            users[actor],
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": port},
            expected_state=draft["state"],
        )


def test_port_stale_edit_conflicts_and_keyed_create_replays(users, project, av):
    owner = users["owner"]
    port = examples.console_port(av["variants"]["Console A AV"], "Console A")
    first = create(owner, project, port, idempotency_key="port")
    assert create(owner, project, port, idempotency_key="port") == first
    with pytest.raises(IdempotencyMismatch):
        create(owner, project, {**port, "device_label": "Other"}, idempotency_key="port")
    op(
        owner,
        "interface.update",
        {"draft_id": first["draft_id"], "interface": {**port, "device_label": "Console A2"}},
        expected_state=first["state"],
    )
    with pytest.raises(Conflict):
        op(
            owner,
            "interface.update",
            {"draft_id": first["draft_id"], "interface": port},
            expected_state=first["state"],
        )


def test_http_entry_point_reads_cable_end_expectations(users, project, av):
    port = frozen(
        users["owner"],
        project,
        examples.console_port(av["variants"]["Console A AV"], "Console A AV out"),
    )
    client = Client()
    client.force_login(users["contributor"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "interface.create",
                "request_id": "port-api",
                "payload": {
                    "workspace_id": workspace_of(project),
                    "name": "HTTP port",
                    "interface": examples.rgb_monitor_port(av["sink"]),
                },
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    end = client.get(f"/api/v0/interfaces/revisions/{port}/end")
    assert end.status_code == 200 and end.json()["device_label"] == "Console A AV out"
    assert client.get(f"/api/v0/interfaces/revisions/{av['sink']}/end").json()["kind"] == "pinout"
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/interfaces/revisions/{port}/end").status_code == 404
