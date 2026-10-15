"""PCB-006/PCB-003/TOP-001/TOP-002: board labelled terminals and declared paths."""

import copy
import json

import pytest
from django.test import Client

from specmate.design.models import Revision
from specmate.interfaces import examples
from specmate.interfaces.queries import inspect_revision
from specmate.operations import (
    Conflict,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import ensure_member, op
from .scope_helpers import workspace_of
from .test_copper import board_population
from .test_interface_ports import create, freeze, frozen
from .test_pcb import attempt as pcb_attempt  # noqa: F401
from .test_pcb import intake, recipe, source  # noqa: F401


@pytest.fixture
def plug(users, project):
    owner = users["owner"]
    socket = frozen(owner, project, examples.round_din_10_socket(), "10-pin round DIN socket")
    return frozen(owner, project, examples.round_din_10_plug(socket), "10-pin round DIN plug")


@pytest.fixture
def adapter(users, project, plug):
    return frozen(users["owner"], project, examples.av_adapter_board(plug), "AV adapter board")


def trace(user, revision, start, end, query="dc_continuity", **extra):
    return op(
        user,
        "interface.board_trace",
        {
            "revision_id": revision,
            "from_terminal_id": start,
            "to_terminal_id": end,
            "query": query,
            **extra,
        },
    )


def by_id(rows, key="terminal_id"):
    return {row[key]: row for row in rows}


def test_black_box_board_lists_labelled_pads_landings_and_paths(users, project, adapter, plug):
    view = inspect_revision(users["viewer"], adapter)["board"]
    terminals = by_id(view["terminals"])
    # Labels are display text; landings come only from the reviewed correspondence.
    assert terminals["cs"]["label"] == "CS" and terminals["cs"]["group"] == "Cable side"
    assert terminals["din-4"]["landings"] == [
        {
            "connector_id": "plug",
            "body_name": "10-pin round DIN plug",
            "contact_id": "4",
            "number": "4",
            "label": "4",
            "status": "reviewed",
        }
    ]
    # No declared path is unknown, never "unconnected".
    assert terminals["v5"]["connection"] == "unknown"
    assert terminals["din-8"]["connection"] == "unknown"
    assert terminals["r"]["connection"] == "declared"
    paths = by_id(view["paths"], "local_id")
    assert paths["path-cs"]["summary"] == "R1 470R resistor"
    assert paths["path-cs"]["from_label"] == "CS" and paths["path-cs"]["to_label"] == "1"
    assert paths["path-r"]["summary"] == "Straight copper"
    assert view["connectors"][0]["status"] == "reviewed"
    assert view["connectors"][0]["contacts_without_terminal"] == ["10", "shell"]
    assert view["continuity"] == "not_evaluated"
    snapshot = Revision.objects.get(id=adapter).snapshot
    assert plug in {str(r) for r in snapshot.dependencies.values_list("revision_id", flat=True)}


def test_series_resistor_path_is_interpreted_by_the_passive_model(users, adapter):
    viewer = users["viewer"]
    ideal = {"copper_assumption": "ideal_zero_resistance"}
    resistance = trace(viewer, adapter, "cs", "din-1", "resistance", **ideal)
    assert resistance["status"] == "modeled_series_resistance"
    assert resistance["series_resistance_ohm"] == "470"
    assert resistance["paths"][0]["terminal_labels"] == ["CS", "1"]
    straight = trace(viewer, adapter, "r", "din-4", "shortness", **ideal)
    assert straight["status"] == "modeled_ideal_short"
    # Copper is never assumed: without the explicit assumption it stays unknown.
    assert trace(viewer, adapter, "r", "din-4")["status"] == "unknown"
    # Separate signals are not joined, and a missing path is not a disconnection proof.
    apart = trace(viewer, adapter, "r", "g", **ideal)
    assert apart["status"] == "unknown" and apart["paths"] == []
    assert apart["reason"] == "no_modeled_path_is_not_physical_disconnection"
    with pytest.raises(NotFound):
        trace(viewer, adapter, "r", "missing")


def test_copper_graph_keeps_the_resistor_as_a_boundary(users, adapter):
    graph = op(users["viewer"], "copper.graph", {"revision_id": adapter})
    node = {
        n["terminal"]["terminal_id"]: n["id"]
        for n in graph["nodes"]
        if n["terminal"]["kind"] == "board_terminal"
    }

    def component(key):
        return next(c for c in graph["components"] if node[key] in c["members"])

    assert component("r") == component("din-4")
    assert component("r")["evidence"] == ["declared_copper"]
    assert component("cs") != component("din-1")
    resistor = next(b for b in graph["boundaries"] if b["kind"] == "resistor")
    assert resistor["status"] == "not_evaluated"
    assert set(resistor["members"]) == {node["cs"], node["din-1"]}
    landings = [b for b in graph["boundaries"] if b["kind"] == "carried_connector_correspondence"]
    assert len(landings) == 9 and {b["status"] for b in landings} == {"not_evaluated"}


def test_unreviewed_correspondence_reads_unknown(users, project, plug):
    board = examples.av_adapter_board(plug)
    board["carried_connectors"][0].update(review="unreviewed", basis=None)
    revision = frozen(users["owner"], project, board)
    view = inspect_revision(users["owner"], revision)["board"]
    assert view["connectors"][0]["status"] == "unknown"
    assert by_id(view["terminals"])["din-1"]["landings"][0]["status"] == "unknown"
    graph = op(users["owner"], "copper.graph", {"revision_id": revision})
    landings = [b for b in graph["boundaries"] if b["kind"] == "carried_connector_correspondence"]
    assert {b["status"] for b in landings} == {"unknown"}


def test_switch_state_paths_follow_the_selected_state(users, project, plug):
    board = examples.av_adapter_board(plug)
    board["conditions"] = [
        {
            "key": "sync-jumper",
            "name": "Sync jumper",
            "choices": [{"key": "fitted", "name": "Fitted"}, {"key": "open", "name": "Open"}],
        }
    ]
    board["paths"].append(
        {
            "local_id": "bypass",
            "from_terminal": "cs",
            "to_terminal": "din-8",
            "via": "switch",
            "switch": {"condition_key": "sync-jumper", "closed_when": "fitted"},
            "basis": "Synthetic jumper declaration",
        }
    )
    revision = frozen(users["owner"], project, board)
    assert (
        by_id(inspect_revision(users["owner"], revision)["board"]["paths"], "local_id")["bypass"][
            "summary"
        ]
        == "Sync jumper: closed in Fitted"
    )
    ideal = {"copper_assumption": "ideal_zero_resistance"}

    def state(choice):
        extra = {"condition_assignments": [{"condition_id": "sync-jumper", "state": choice}]}
        return trace(users["owner"], revision, "cs", "din-8", **ideal, **(extra if choice else {}))

    assert state(None)["status"] == "unknown"
    assert state("fitted")["status"] == "modeled_dc_path"
    assert state("open")["status"] == "modeled_blocked"
    with pytest.raises(ValidationFailed):
        state("missing")


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda b: b["paths"][0].update(to_terminal="nowhere"), "undeclared terminal"),
        (lambda b: b["paths"][0].update(via="component"), "describes its component"),
        (lambda b: b.update(review="reviewed", review_basis=None), "review basis"),
        (lambda b: b["terminals"][0].update(native_pad_ids=[examples.BASIS]), "uuid"),
        (
            lambda b: b["terminals"][0].update(
                native_pad_ids=["00000000-0000-4000-8000-000000000000"]
            ),
            "KiCad-derived",
        ),
        (
            lambda b: b["carried_connectors"][0]["correspondence"].append(
                {"terminal_id": "v5", "contact_id": "99"}
            ),
            "contact of the carried connector",
        ),
        (
            lambda b: b["paths"][3]["component"].update(resistance_ohm="220"),
            "value and the resistance disagree",
        ),
        (lambda b: b["paths"][0].update(provenance="reported_net_membership"), "KiCad-derived"),
    ],
)
def test_invalid_boards_are_rejected(users, project, plug, mutate, match):
    board = examples.av_adapter_board(plug)
    mutate(board)
    with pytest.raises(ValidationFailed) as error:
        create(users["owner"], project, board)
    assert match in f"{error.value.message} {json.dumps(error.value.details)}"


def test_a_carried_connector_must_be_a_connector_body(users, project, plug):
    signals = frozen(users["owner"], project, examples.av_signal_set())
    with pytest.raises(ValidationFailed, match="connector body"):
        create(users["owner"], project, examples.av_adapter_board(signals))


def test_a_generic_board_stays_valid_and_becomes_typed_on_edit(users, project, plug):
    owner = users["owner"]
    generic = op(
        owner,
        "definition.create",
        {"workspace_id": workspace_of(project), "name": "Untyped board", "kind": "board"},
    )
    with pytest.raises(ValidationFailed, match="Typed interface content"):
        freeze(owner, generic)
    untyped = op(
        owner, "draft.freeze", {"draft_id": generic["draft_id"]}, expected_state=generic["state"]
    )
    assert Revision.objects.filter(definition_id=generic["definition_id"]).count() == 1
    current = untyped["draft"]
    updated = op(
        owner,
        "interface.update",
        {"draft_id": generic["draft_id"], "interface": examples.av_adapter_board(plug)},
        expected_state=current["state"],
    )
    typed = freeze(owner, updated)
    assert inspect_revision(owner, typed["revision_id"])["board"]["origin"] == "black_box"
    with pytest.raises(Conflict):
        op(
            owner,
            "interface.update",
            {"draft_id": generic["draft_id"], "interface": examples.av_adapter_board(plug)},
            expected_state=updated["state"],
        )


@pytest.mark.parametrize("actor,error", [("viewer", PermissionDenied), ("outsider", NotFound)])
def test_board_authoring_scope(users, project, plug, actor, error):
    board = examples.av_adapter_board(plug)
    with pytest.raises(error):
        create(users[actor], project, board)
    draft = create(users["owner"], project, board)
    with pytest.raises(error):
        op(
            users[actor],
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": board},
            expected_state=draft["state"],
        )


def test_board_pins_stay_inside_one_workspace(users, project, adapter, other_workspace):
    outsider = users["outsider"]
    foreign = frozen(outsider, other_workspace, examples.round_din_10_socket())
    with pytest.raises(NotFound):
        create(users["owner"], project, examples.av_adapter_board(foreign))
    with pytest.raises(NotFound):
        trace(outsider, adapter, "cs", "din-1")


@pytest.fixture
def population(users, request):
    draft, report = board_population(users, request.getfixturevalue("pcb_attempt"))
    revision = op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    return revision["revision_id"], report


def components_by_reference(report):
    return {c["reference"]: c["id"] for c in report["components"]}


def test_kicad_proposal_needs_an_explicit_component_choice(users, population):
    revision, _report = population
    proposal = op(users["viewer"], "interface.board_propose", {"population_revision_id": revision})
    # No accepted port association: nothing is chosen on the user's behalf.
    assert proposal["board"]["terminals"] == [] and proposal["board"]["paths"] == []
    assert {c["reference"]: c["selected"] for c in proposal["components"]} == {
        "J1": False,
        "J2": False,
        "R1": False,
    }
    assert proposal["review"] == "required"


def test_kicad_proposal_turns_native_passages_and_nets_into_reviewable_paths(
    users, project, population
):
    revision, report = population
    refs = components_by_reference(report)
    owner = users["owner"]
    proposal = op(
        owner,
        "interface.board_propose",
        {"population_revision_id": revision, "component_ids": [refs["J1"], refs["J2"]]},
    )
    board = proposal["board"]
    assert board["origin"] == "kicad_derived" and board["review"] == "unreviewed"
    terminals = by_id(board["terminals"])
    assert {k: t["label"] for k, t in terminals.items()} == {"j1-1": "left", "j2-1": "right"}
    pads = {p["terminal"]: p["id"] for p in report["pads"]}
    assert terminals["j1-1"]["native_pad_ids"] == [pads["J1.1"]]
    [path] = board["paths"]
    assert path["via"] == "component" and path["provenance"] == "native_component_passage"
    assert path["component"]["kind"] == "resistor" and path["component"]["reference"] == "R1"
    assert path["component"]["resistance_ohm"] == "100.0"
    assert {path["from_terminal"], path["to_terminal"]} == {"j1-1", "j2-1"}
    # Choosing the resistor's pads too adds copper paths from reported net membership.
    wider = op(
        owner,
        "interface.board_propose",
        {
            "population_revision_id": revision,
            "component_ids": [refs["J1"], refs["J2"], refs["R1"]],
        },
    )["board"]
    copper = [p for p in wider["paths"] if p["via"] == "copper"]
    assert len(copper) == 2 and {p["provenance"] for p in copper} == {"reported_net_membership"}
    # Accepting is a separate, explicit create; the frozen board pins the population.
    created = freeze(owner, create(owner, project, board, "Derived two-net board"))
    view = inspect_revision(users["viewer"], created["revision_id"])["board"]
    assert view["derived_from"]["population_revision_id"] == revision
    snapshot = Revision.objects.get(id=created["revision_id"]).snapshot
    assert revision in {str(r) for r in snapshot.dependencies.values_list("revision_id", flat=True)}
    graph = op(owner, "copper.graph", {"revision_id": created["revision_id"]})
    assert [b["kind"] for b in graph["boundaries"]] == ["resistor"]
    stale = copy.deepcopy(board)
    stale["terminals"][0]["native_pad_ids"] = ["00000000-0000-4000-8000-000000000000"]
    with pytest.raises(ValidationFailed, match="native pad"):
        create(owner, project, stale)
    narrowed = op(
        owner,
        "interface.board_propose",
        {"population_revision_id": revision, "component_ids": [refs["J1"]]},
    )
    assert narrowed["board"]["paths"] == [] and len(narrowed["unmapped_passages"]) == 1


def test_kicad_proposal_scope_and_source_kind(users, population, adapter):
    revision, _ = population
    with pytest.raises(NotFound):
        op(users["outsider"], "interface.board_propose", {"population_revision_id": revision})
    with pytest.raises(ValidationFailed, match="PCB population"):
        op(users["owner"], "interface.board_propose", {"population_revision_id": adapter})


def test_http_entry_points_trace_and_propose(users, project, adapter, population):
    revision, report = population
    ensure_member(users["contributor"], "contributor")
    client = Client()
    client.force_login(users["contributor"])
    response = client.get(
        f"/api/v0/interfaces/revisions/{adapter}/board-trace",
        {
            "from_terminal_id": "cs",
            "to_terminal_id": "din-1",
            "query": "resistance",
            "copper_assumption": "ideal_zero_resistance",
        },
    )
    assert response.status_code == 200 and response.json()["series_resistance_ohm"] == "470"
    refs = components_by_reference(report)
    proposal = client.get(
        "/api/v0/interfaces/boards/propose",
        {"population_revision_id": revision, "component_id": [refs["J1"], refs["J2"]]},
    )
    assert proposal.status_code == 200 and len(proposal.json()["board"]["terminals"]) == 2
    created = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "interface.create",
                "request_id": "board-api",
                "payload": {
                    "workspace_id": workspace_of(project),
                    "name": "HTTP board",
                    "interface": proposal.json()["board"],
                },
            }
        ),
        content_type="application/json",
    )
    assert created.status_code == 200
    client.force_login(users["outsider"])
    assert (
        client.get(
            f"/api/v0/interfaces/revisions/{adapter}/board-trace",
            {"from_terminal_id": "cs", "to_terminal_id": "din-1"},
        ).status_code
        == 404
    )
