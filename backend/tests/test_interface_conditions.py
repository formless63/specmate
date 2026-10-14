"""ACC-INT-004: exact stable mirrored identities and independent scoped-rating oracles."""

import copy
import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import close_old_connections, connections
from pydantic import ValidationError

from specmate.access.models import Membership
from specmate.design.models import Snapshot
from specmate.interfaces.condition_contracts import ConditionalRating, TemperatureEnvelope
from specmate.interfaces.contracts import ConnectorBody, ElectricalContract, Orientation
from specmate.interfaces.orientation import project_contacts
from specmate.interfaces.queries import inspect_revision
from specmate.operations import Conflict, NotFound, PermissionDenied

from .conftest import op
from .test_interface_assessments import assessment
from .test_interface_assessments import pair as base_pair
from .test_interfaces import create, freeze
from .test_sources import files, register
from .test_transports import api, post_op


@pytest.fixture
def pair(users, project):
    return base_pair.__wrapped__(users, project)


def rating(local_id="warm", dimension="current", maximum=0.5):
    return {
        "local_id": local_id,
        "dimension": dimension,
        "minimum": -5 if dimension == "voltage" else None,
        "maximum": maximum,
        "scope": {"temperature": {"minimum_c": 20, "maximum_c": 60}, "mode": "steady"},
        "basis": "Original synthetic declared envelope, no physical qualification",
    }


def rated_pair(users, project, pair, ratings=None, **electrical):
    pins = []
    for pin in pair[1]:
        value = inspect_revision(users["owner"], pin["revision_id"])["interface"]
        declaration = value["assignments"][0]["electrical"]
        declaration.update(current_max_a=None, voltage_min_v=None, voltage_max_v=None)
        declaration.update(electrical)
        declaration["conditional_ratings"] = ratings if ratings is not None else [rating()]
        pins.append(freeze(users["owner"], create(users["owner"], project, value)))
    return pair[0], pins


def findings(users, project, pair, operating):
    value = assessment(pair)
    value["pairs"][0]["operating"] = {"basis": "Explicit synthetic operating envelope", **operating}
    frozen = freeze(users["owner"], create(users["owner"], project, value))
    result = inspect_revision(users["viewer"], frozen["revision_id"])["assessment"]
    return {f["dimension"]: f for f in result["findings"]}, frozen


@pytest.mark.parametrize(
    "temperature,mode,demand,status,scope",
    [
        ({"minimum_c": 20, "maximum_c": 60}, "steady", 0.5, "satisfied", "in_scope"),
        ({"minimum_c": 25, "maximum_c": 40}, "steady", 0.6, "invalid", "in_scope"),
        ({"minimum_c": 19, "maximum_c": 60}, "steady", 0.1, "unknown", "out_of_scope"),
        ({"minimum_c": 25, "maximum_c": 61}, "steady", 0.1, "unknown", "out_of_scope"),
        (None, "steady", 0.1, "unknown", "unknown"),
        ({"minimum_c": 25, "maximum_c": 40}, None, 0.1, "unknown", "unknown"),
        ({"minimum_c": 25, "maximum_c": 40}, "pulse", 0.1, "unknown", "out_of_scope"),
    ],
)
def test_temperature_and_named_mode_apply_only_in_explicit_scope(
    users, project, pair, temperature, mode, demand, status, scope
):
    rated = rated_pair(users, project, pair)
    result, frozen = findings(
        users, project, rated, {"temperature": temperature, "mode": mode, "demand_a": demand}
    )
    current = result["current"]
    assert current["status"] == status
    for side in ("left", "right"):
        facts = current["facts"]["rating_scope"][side]
        assert facts["conditional_ratings"][0]["status"] == scope
        assert facts["effective_limits"] == ([None, 0.5] if scope == "in_scope" else None)
    assert result["mating"]["status"] == "satisfied"
    assert result["polarity"]["status"] == "unknown"
    client = api(users["viewer"])
    assert client.get(f"/api/v0/interfaces/revisions/{frozen['revision_id']}").status_code == 200
    assert post_op(client, "interface.read", {"revision_id": frozen["revision_id"]}).json()[
        "result"
    ]["assessment"]["findings"] == list(result.values())


def test_overlapping_limits_intersect_without_extrapolation_or_unknown_fallback(
    users, project, pair
):
    lower = rating("lower", maximum=0.25)
    values = [rating(), lower, rating("voltage", "voltage", 5)]
    rated = rated_pair(users, project, pair, values, current_max_a=2)
    result, _ = findings(
        users,
        project,
        rated,
        {
            "temperature": {"minimum_c": 30, "maximum_c": 50},
            "mode": "steady",
            "demand_a": 0.3,
            "voltage_min_v": -4,
            "voltage_max_v": 5,
        },
    )
    assert result["current"]["status"] == "invalid"  # independent min(0.5, 0.25, 2) = 0.25
    assert result["levels"]["status"] == "satisfied"  # independent inclusive [-5, 5]
    result, _ = findings(users, project, rated, {"mode": "steady", "demand_a": 0.1})
    assert (
        result["current"]["status"] == "unknown"
    )  # unconditional 2 A cannot erase missing temperature
    assert result["current"]["facts"]["rating_scope"]["left"]["effective_limits"] is None


def test_polarity_is_independent_and_does_not_follow_contact_labels(users, project, pair):
    rated = rated_pair(
        users, project, pair, [], polarity="positive", polarity_basis="Declared contact polarity"
    )
    result, _ = findings(users, project, rated, {})
    assert result["polarity"]["status"] == "satisfied"
    pin = inspect_revision(users["owner"], rated[1][1]["revision_id"])["interface"]
    pin["assignments"][0]["electrical"]["polarity"] = "negative"
    rated[1][1] = freeze(users["owner"], create(users["owner"], project, pin))
    result, _ = findings(users, project, rated, {})
    assert result["polarity"]["status"] == "invalid"
    assert result["pin_correspondence"]["status"] == "satisfied"
    assert result["mating"]["status"] == "satisfied"


def test_mirror_rotation_preserve_stable_ids_repeated_numbers_and_frozen_history(users, project):
    owner = users["owner"]
    body = {
        "kind": "connector_body",
        "drawing_orientation": {
            "viewing_side": "termination",
            "rotation_degrees": 0,
            "datum": "origin-key",
        },
        "contacts": [
            {"contact_id": "left", "number": "1", "label": "same", "position_mm": [-2, 1]},
            {"contact_id": "right", "number": "1", "label": "same", "position_mm": [3, -1]},
            {"contact_id": "absent", "position_mm": None},
        ],
    }
    body_revision = freeze(owner, create(owner, project, body))
    pin = {
        "kind": "pinout",
        "body_revision_id": body_revision["revision_id"],
        "orientation": {"viewing_side": "mating", "rotation_degrees": 0, "datum": "origin-key"},
    }
    draft = create(owner, project, pin)
    frozen = freeze(owner, draft)
    before = inspect_revision(owner, frozen["revision_id"])
    rows = before["contact_view"]["contacts"]
    assert [(r["contact_id"], r["number"], r["display_position_mm"]) for r in rows] == [
        ("left", "1", [2, 1]),
        ("right", "1", [-3, -1]),
        ("absent", None, None),
    ]
    assert before["contact_view"]["mirrored"] is True
    assert before["contact_views"]["termination"]["contacts"][0]["display_position_mm"] == [-2, 1]
    raw = bytes(Snapshot.objects.get(pk=frozen["snapshot_id"]).canonical)
    pin["orientation"]["rotation_degrees"] = 90
    updated = op(
        owner,
        "interface.update",
        {"draft_id": draft["draft_id"], "interface": pin},
        expected_state=frozen["draft"]["state"],
    )
    turned = freeze(owner, updated)
    assert inspect_revision(owner, turned["revision_id"])["contact_view"]["contacts"][0][
        "display_position_mm"
    ] == pytest.approx([1, -2])
    assert inspect_revision(owner, frozen["revision_id"]) == before
    assert bytes(Snapshot.objects.get(pk=frozen["snapshot_id"]).canonical) == raw
    pin["orientation"]["datum"] = "different-origin"
    unknown = freeze(owner, create(owner, project, pin))
    unresolved = inspect_revision(owner, unknown["revision_id"])["contact_view"]
    assert unresolved["mirrored"] is None
    assert unresolved["contacts"][0]["display_position_mm"] is None
    assert "datums" in unresolved["contacts"][0]["reason"]


def test_rating_evidence_rechecks_current_full_historic_scope_before_diagnostics(
    users, project, pair
):
    owner = users["owner"]
    remote = op(owner, "project.create", {"name": "Synthetic independent rating evidence"})[
        "project_id"
    ]
    data = b"Original synthetic temperature rating declaration"
    register(owner, remote, data)
    source = op(
        owner,
        "source.create_original_bundle",
        {"project_id": remote, "name": "Synthetic limits", "files": files(data)},
    )
    declared = rating()
    declared["evidence"] = {
        "status": "registered_file",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "src/source.txt",
    }
    rated = rated_pair(users, project, pair, [declared])
    value = inspect_revision(owner, rated[1][0]["revision_id"])["interface"]
    draft = create(owner, project, value, idempotency_key="rated-create")
    frozen = freeze(owner, draft, idempotency_key="rated-freeze")
    before = inspect_revision(owner, frozen["revision_id"])
    evidence = before["rating_evidence"]["data"]["warm"]
    assert evidence["sha256"] == hashlib.sha256(data).hexdigest()
    assert evidence["rights"] == "synthetic-original"
    Membership.objects.filter(project_id=remote, user=owner).delete()
    invalid = copy.deepcopy(value)
    invalid["assignments"][0]["contact_id"] = "absent"
    for action in (
        lambda: create(owner, project, invalid),
        lambda: create(owner, project, invalid, idempotency_key="rated-create"),
        lambda: inspect_revision(owner, frozen["revision_id"]),
        lambda: freeze(owner, draft, idempotency_key="rated-freeze"),
        lambda: op(
            owner,
            "draft.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=frozen["draft"]["state"],
        ),
    ):
        with pytest.raises(NotFound):
            action()
    Membership.objects.create(project_id=remote, user=owner, role="owner")
    assert inspect_revision(owner, frozen["revision_id"]) == before
    assert freeze(owner, draft, idempotency_key="rated-freeze") == frozen
    with pytest.raises(PermissionDenied):
        create(users["viewer"], project, value)


@pytest.mark.django_db(transaction=True)
def test_competing_conditional_edits_preserve_one_exact_cas_winner(users, project, pair):
    pin = inspect_revision(users["owner"], pair[1][0]["revision_id"])["interface"]
    draft = create(users["owner"], project, pin)
    barrier = Barrier(2)

    def write(maximum):
        close_old_connections()
        try:
            edited = copy.deepcopy(pin)
            edited["assignments"][0]["electrical"]["conditional_ratings"] = [
                rating(maximum=maximum)
            ]
            barrier.wait(timeout=5)
            return op(
                users["owner"],
                "interface.update",
                {"draft_id": draft["draft_id"], "interface": edited},
                expected_state=draft["state"],
            )
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, [0.25, 0.5]))
    assert sum(r == "conflict" for r in results) == 1
    winner = next(r for r in results if r != "conflict")
    frozen = freeze(users["owner"], winner)
    assert (
        inspect_revision(users["owner"], frozen["revision_id"])["interface"]["assignments"][0][
            "electrical"
        ]["conditional_ratings"]
        == winner["content"]["interface"]["assignments"][0]["electrical"]["conditional_ratings"]
    )


@pytest.mark.parametrize("change", [{"maximum": -1}, {"scope": {}}, {"minimum": 0}, {"basis": ""}])
def test_invalid_rating_declarations_are_rejected(change):
    with pytest.raises(ValidationError):
        ConditionalRating.model_validate({**rating(), **change})


@pytest.mark.parametrize("low,high", [(-274, 0), (30, 20), (float("nan"), 30)])
def test_temperature_bounds_are_finite_ordered_and_physical_units_explicit(low, high):
    with pytest.raises(ValidationError):
        TemperatureEnvelope(minimum_c=low, maximum_c=high)


def test_polarity_and_rating_ids_require_explicit_declarations():
    with pytest.raises(ValidationError):
        ElectricalContract(polarity="positive")
    with pytest.raises(ValidationError):
        ElectricalContract(conditional_ratings=[rating(), rating()])


@pytest.mark.parametrize(
    "source_side,source_rotation,target_side,target_rotation,expected,reason",
    [
        ("mating", 90, "mating", 90, [-2, 1], None),
        ("termination", 90, "mating", 0, [1, -2], None),
        ("termination", None, "mating", None, None, "rotations"),
        ("termination", 0, "unknown", None, None, "viewing side"),
    ],
)
def test_declared_rotation_and_unknown_orientation_oracles(
    source_side, source_rotation, target_side, target_rotation, expected, reason
):
    body = ConnectorBody(
        contacts=[{"contact_id": "stable", "number": "1", "position_mm": [-2, 1]}],
        drawing_orientation=Orientation(
            viewing_side=source_side,
            rotation_degrees=source_rotation,
            datum="origin" if source_rotation is not None else None,
        ),
    )
    target = Orientation(
        viewing_side=target_side,
        rotation_degrees=target_rotation,
        datum="origin" if target_rotation is not None else None,
    )
    row = project_contacts(body, target)["contacts"][0]
    assert row["contact_id"] == "stable" and row["number"] == "1"
    if expected is not None:
        assert row["display_position_mm"] == pytest.approx(expected)
        assert row["reason"] is None
    else:
        assert row["display_position_mm"] is None and reason in row["reason"]


def test_finite_source_coordinates_cannot_emit_nonfinite_display_geometry():
    orientation = Orientation(viewing_side="mating", rotation_degrees=45, datum="origin")
    body = ConnectorBody(
        contacts=[{"contact_id": "large", "position_mm": [1.7e308, 1.7e308]}],
        drawing_orientation=orientation,
    )
    row = project_contacts(body, orientation.model_copy(update={"rotation_degrees": 0}))[
        "contacts"
    ][0]
    assert row["source_position_mm"] == (1.7e308, 1.7e308)
    assert row["display_position_mm"] is None and "finite" in row["reason"]
