"""INT-001/CAB-006: conductor conventions are exact, scoped preferences, never evidence."""

import copy
import json

import pytest
from django.test import Client

from specmate.interfaces import examples
from specmate.interfaces.conventions import stock_conventions
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


def create(user, scope, interface, name="Synthetic convention", **ctx):
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


def frozen(user, scope, interface, name="Synthetic convention"):
    return freeze(user, create(user, scope, interface, name))["revision_id"]


def frozen_stock(user, scope, stock=None, name="Six-coax AV stock"):
    draft = op(
        user,
        "wire_stock.create",
        {
            "workspace_id": workspace_of(scope),
            "name": name,
            "stock": stock or examples.six_coax_stock(),
        },
    )
    return op(
        user, "wire_stock.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )["revision_id"]


@pytest.fixture
def kit(users, project):
    owner = users["owner"]
    return {
        "signals": frozen(owner, project, examples.av_signal_set(), "Workshop AV signals"),
        "stock": frozen_stock(owner, project),
    }


def convention(kit, **patch):
    value = examples.av_coax_convention(kit["signals"], kit["stock"])
    value.update(patch)
    return value


def by_path(view):
    return {row["element_path"]: row for row in view["rows"]}


def test_stock_convention_maps_centers_and_screens_by_label_and_signal_name(users, project, kit):
    owner = users["owner"]
    revision = frozen(owner, project, convention(kit), "Six-coax AV convention")
    view = inspect_revision(users["viewer"], revision)["convention"]
    rows = by_path(view)
    assert view["scope"] == "stock" and view["effect"] == "preference"
    assert len(rows) == 12 and view["unmapped"] == []
    red = rows["stock.core-1.center"]
    assert red["element_label"] == "Core 1 (red) / Center"
    assert red["use"]["signal"]["name"] == "Red video"
    screen = rows["stock.core-1.screen"]
    assert (screen["use"]["kind"], screen["use"]["signal"]["name"]) == ("return_of", "Red video")
    assert rows["stock.core-4.center"]["use"]["signal"]["name"] == "Composite sync"
    assert view["stock"]["name"] == "Six-coax AV stock" and view["stock"]["number"] == 1
    assert "never makes a check pass" in view["effect_note"]


def test_unmapped_elements_stay_unknown_not_spare(users, project, kit):
    value = convention(kit)
    value["rules"] = value["rules"][:-2]
    view = inspect_revision(users["owner"], frozen(users["owner"], project, value))["convention"]
    assert [u["element_path"] for u in view["unmapped"]] == [
        "stock.core-6.center",
        "stock.core-6.screen",
    ]
    assert all("use" not in u for u in view["unmapped"])


def test_spare_and_type_only_rules_and_preference_levels(users, project, kit):
    value = convention(kit)
    value["rules"][0]["use"] = {"kind": "signal_type", "signal_type": "analog_video"}
    value["rules"][0]["preference"] = "allowed"
    value["rules"][2]["use"] = {"kind": "spare"}
    value["rules"][2]["preference"] = "avoid"
    rows = by_path(
        inspect_revision(users["owner"], frozen(users["owner"], project, value))["convention"]
    )
    assert rows["stock.core-1.center"]["use"]["signal_type"] == "analog_video"
    assert rows["stock.core-1.center"]["use"]["signal"] is None
    assert rows["stock.core-2.center"]["use"]["kind"] == "spare"
    assert rows["stock.core-2.center"]["preference"] == "avoid"


@pytest.mark.parametrize(
    "mutate,error,match",
    [
        (
            lambda v, k: v["rules"][0].update(element_path="stock.core-9.center"),
            ValidationFailed,
            "pinned stock",
        ),
        (
            lambda v, k: v["rules"][0].update(element_path="stock.core-1.dielectric"),
            ValidationFailed,
            "pinned stock",
        ),
        (
            lambda v, k: v["rules"][0].update(element_path="stock.core-1"),
            ValidationFailed,
            "pinned stock",
        ),
        (
            lambda v, k: v["rules"][0]["use"].update(signal_key="nope"),
            ValidationFailed,
            "not declared",
        ),
        (
            lambda v, k: v["rules"][1]["use"].update(signal_key="audio_ground"),
            ValidationFailed,
            "return of",
        ),
        (lambda v, k: v.update(stock_revision_id=k["signals"]), ValidationFailed, "wire stock"),
        (lambda v, k: v.update(signal_set_revision_id=k["stock"]), ValidationFailed, "signal set"),
        (
            lambda v, k: v.update(rules=[*v["rules"], copy.deepcopy(v["rules"][0])]),
            ValidationFailed,
            None,
        ),
        (lambda v, k: v.update(stock_revision_id=None), ValidationFailed, None),
        (
            lambda v, k: v["rules"][0].update(element_path=None, color="Red"),
            ValidationFailed,
            None,
        ),
        (
            lambda v, k: v["rules"][0]["use"].update(signal_type="analog_video"),
            ValidationFailed,
            None,
        ),
        (lambda v, k: v["rules"][0].update(color="Red"), ValidationFailed, None),
        (lambda v, k: v.update(review="reviewed", review_basis=None), ValidationFailed, None),
    ],
)
def test_invalid_conventions_are_rejected(users, project, kit, mutate, error, match):
    value = convention(kit)
    mutate(value, kit)
    with pytest.raises(error, match=match):
        create(users["owner"], project, value)


def test_one_element_maps_once_even_with_a_different_use(users, project, kit):
    value = convention(kit)
    value["rules"].append(
        {"element_path": "stock.core-1.center", "use": {"kind": "spare"}, "basis": "again"}
    )
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, value)


def test_color_code_matches_elements_by_exact_display_color_only(users, project, kit):
    owner = users["owner"]
    code = frozen(owner, project, examples.av_color_code(kit["signals"]), "AV color code")
    view = inspect_revision(owner, code)["convention"]
    assert view["scope"] == "color_code" and view["stock"] is None
    assert [r["color"] for r in view["rows"]] == ["Red", "Gray"]
    found = stock_conventions(users["viewer"], kit["stock"])["conventions"]
    [entry] = found
    assert entry["scope"] == "color_code" and entry["exact"] is False
    assert {m["element_path"] for m in entry["matches"]} == {
        "stock.core-1.center",
        "stock.core-6.center",
    }
    # A stock with unknown colors is matched by nothing: labels never establish meaning.
    plain = examples.six_coax_stock()
    for core in plain["structure"]["children"][:-1]:
        core["children"][0]["color"] = None
        core["label"] = "Core (red)"
    other = frozen_stock(owner, project, plain, "Uncolored stock")
    assert stock_conventions(owner, other)["conventions"] == []


def test_color_code_cannot_pin_a_stock_nor_a_stock_rule_use_a_color(users, project, kit):
    code = examples.av_color_code(kit["signals"])
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, {**code, "stock_revision_id": kit["stock"]})
    with pytest.raises(ValidationFailed):
        create(
            users["owner"],
            project,
            {**code, "rules": [{"element_path": "stock.core-1.center", "use": {"kind": "spare"}}]},
        )


def test_stock_side_lookup_lists_exact_first_then_other_revisions(users, project, kit):
    owner = users["owner"]
    exact = frozen(owner, project, convention(kit), "Six-coax AV convention")
    found = stock_conventions(users["viewer"], kit["stock"])
    [entry] = found["conventions"]
    assert entry["exact"] is True and entry["revision_id"] == exact
    assert entry["convention"]["rows"][0]["use"]["signal"]["name"] == "Red video"
    assert found["effect"] == "preference"
    # A later revision of the stock keeps the older convention listed, without rows.
    draft = op(
        owner,
        "wire_stock.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Second stock",
            "stock": examples.six_coax_stock(),
        },
    )
    second = op(
        owner, "wire_stock.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )["revision_id"]
    assert stock_conventions(owner, second)["conventions"] == []


def test_stock_lookup_scope_and_workspace_isolation(users, project, kit, other_workspace):
    frozen(users["owner"], project, convention(kit))
    with pytest.raises(NotFound):
        stock_conventions(users["outsider"], kit["stock"])
    with pytest.raises(NotFound):
        stock_conventions(users["owner"], kit["signals"])
    ensure_member(users["owner"], "admin", workspace=other_workspace)
    with pytest.raises(NotFound):
        create(users["owner"], other_workspace, convention(kit))
    foreign_stock = frozen_stock(users["outsider"], other_workspace, name="Foreign stock")
    with pytest.raises(NotFound):
        create(users["owner"], project, convention(kit, stock_revision_id=foreign_stock))


@pytest.mark.parametrize("actor,error", [("viewer", PermissionDenied), ("outsider", NotFound)])
def test_convention_authoring_scope(users, project, kit, actor, error):
    with pytest.raises(error):
        create(users[actor], project, convention(kit))
    draft = create(users["owner"], project, convention(kit))
    with pytest.raises(error):
        op(
            users[actor],
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": convention(kit)},
            expected_state=draft["state"],
        )
    with pytest.raises(error):
        op(
            users[actor],
            "interface.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )


def test_convention_stale_edit_conflicts_and_keyed_create_replays(users, project, kit):
    owner = users["owner"]
    value = convention(kit)
    first = create(owner, project, value, idempotency_key="convention")
    assert create(owner, project, value, idempotency_key="convention") == first
    with pytest.raises(IdempotencyMismatch):
        create(owner, project, {**value, "description": "Other"}, idempotency_key="convention")
    op(
        owner,
        "interface.update",
        {"draft_id": first["draft_id"], "interface": {**value, "description": "Edited"}},
        expected_state=first["state"],
    )
    with pytest.raises(Conflict):
        op(
            owner,
            "interface.update",
            {"draft_id": first["draft_id"], "interface": value},
            expected_state=first["state"],
        )


def test_a_draft_cannot_change_kind_to_a_convention(users, project, kit):
    draft = create(users["owner"], project, examples.av_signal_set())
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": convention(kit)},
            expected_state=draft["state"],
        )


def test_http_entry_points_create_and_read_stock_conventions(users, project, kit):
    client = Client()
    client.force_login(users["contributor"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "interface.create",
                "request_id": "convention-api",
                "payload": {
                    "workspace_id": workspace_of(project),
                    "name": "HTTP convention",
                    "interface": convention(kit),
                },
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    exact = frozen(users["owner"], project, convention(kit), "Frozen convention")
    listing = client.get(f"/api/v0/interfaces/stock-revisions/{kit['stock']}/conventions")
    assert listing.status_code == 200
    assert listing.json()["conventions"][0]["revision_id"] == exact
    client.force_login(users["outsider"])
    gone = client.get(f"/api/v0/interfaces/stock-revisions/{kit['stock']}/conventions")
    assert gone.status_code == 404
