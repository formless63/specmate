import copy
import json
from uuid import uuid4

import pytest
from django.test import Client

from specmate.access.models import Membership
from specmate.copper.contracts import ReadGraph
from specmate.copper.queries import inspect_graph
from specmate.design.models import Snapshot
from specmate.operations import NotFound, ValidationFailed

from .conftest import op
from .test_cables import capture as cable_capture
from .test_cables import create as cable_create
from .test_cables import fixture as cable_fixture
from .test_harnesses import capture, create, fixture, source_backed_stock
from .test_interfaces import create as interface_create
from .test_interfaces import freeze as interface_freeze
from .test_interfaces import setup_mapping
from .test_pcb import attempt as pcb_attempt  # noqa: F401
from .test_pcb import intake, recipe, report_payload, source, successful_output  # noqa: F401


def graph(user, revision, **kwargs):
    return op(user, "copper.graph", {"revision_id": revision["revision_id"], **kwargs})


def component_for(result, **terminal):
    node = next(
        n for n in result["nodes"] if all(n["terminal"].get(k) == v for k, v in terminal.items())
    )
    return next(c for c in result["components"] if node["id"] in c["members"])


def assembly(user, project, children, relationships=()):
    draft = op(
        user,
        "assembly.create",
        {
            "project_id": project,
            "name": "Synthetic composition",
            "assembly": {
                "occurrences": [
                    {"local_id": name, "revision_id": rev["revision_id"]} for name, rev in children
                ],
                "relationships": list(relationships),
            },
        },
    )
    return op(
        user, "assembly.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


def test_cable_connects_exact_ends_without_bonding_shield_drain_or_keys(users, project):
    owner = users["owner"]
    *_, cable = cable_fixture(owner, project)
    frozen = cable_capture(owner, cable_create(owner, project, cable))
    result = graph(owner, frozen)
    core = component_for(result, kind="endpoint", endpoint_id="left", contact_id="a")
    assert core == component_for(result, kind="endpoint", endpoint_id="right", contact_id="b")
    assert len(core["members"]) == 4
    screen = component_for(
        result, kind="cable_conductor", element_path="stock.screen", endpoint_id="left"
    )
    assert len(screen["members"]) == 2 and screen != core
    assert screen != component_for(
        result, kind="cable_conductor", element_path="stock.drain", endpoint_id="left"
    )
    assert all(n["terminal"].get("contact_id") != "key" for n in result["nodes"])
    assert result["continuity"] == result["physical_qualification"] == "not_evaluated"
    assert core["evidence"] == ["declared_copper"]


def test_harness_explicit_through_splice_and_bond_preserve_feature_identity(users, project):
    *_, value = fixture(users["owner"], project)
    frozen = capture(users["owner"], create(users["owner"], project, value))
    result = graph(users["owner"], frozen)
    core = component_for(result, kind="endpoint", endpoint_id="input", contact_id="a")
    assert core == component_for(result, kind="endpoint", endpoint_id="output", contact_id="b")
    assert len(core["members"]) == 6
    shield = component_for(result, kind="endpoint", endpoint_id="input", contact_id="shell")
    assert len(shield["members"]) == 5 and shield != core
    assert component_for(
        result, kind="segment", segment_id="trunk", end="a", element_path="stock.drain"
    ) == component_for(
        result, kind="segment", segment_id="leg-two", end="b", element_path="stock.core"
    )
    assert any(b["status"] == "declared_unconnected" for b in result["boundaries"])
    assert {
        n["provenance"].get("section_id")
        for n in result["nodes"]
        if n["terminal"]["kind"] == "segment"
    } == {"shared", "branch"}


def test_shared_material_label_and_unknown_fates_do_not_merge_spans(users, project):
    *_, value = fixture(users["owner"], project)
    value["joints"] = []
    value["breakouts"][0]["fates"] = []
    for segment in value["segments"]:
        segment["label"] = "Shared label"
    frozen = capture(users["owner"], create(users["owner"], project, value))
    result = graph(users["owner"], frozen)
    assert component_for(
        result, segment_id="trunk", end="b", element_path="stock.core"
    ) != component_for(result, segment_id="leg-one", end="a", element_path="stock.core")
    assert {e["kind"] for e in result["edges"]} == {"wire"}
    assert {b["status"] for b in result["boundaries"]} == {"unknown"}


def test_repeated_occurrences_and_exact_historical_revisions_stay_separate(users, project):
    owner = users["owner"]
    *_, cable = cable_fixture(owner, project)
    draft = cable_create(owner, project, cable)
    frozen = cable_capture(owner, draft)
    nested = assembly(owner, project, [("lead", frozen)])
    root = assembly(owner, project, [("first", nested), ("second", nested)])
    result = graph(owner, root)
    assert {tuple(n["occurrence_path"]) for n in result["nodes"]} == {
        ("first", "lead"),
        ("second", "lead"),
    }
    assert all(
        len({tuple(n["occurrence_path"]) for n in result["nodes"] if n["id"] in c["members"]}) == 1
        for c in result["components"]
    )
    subset = graph(owner, root, occurrence_path=["second"])
    assert len(subset["nodes"]) * 2 == len(result["nodes"])
    assert {n["id"] for n in subset["nodes"]}.issubset({n["id"] for n in result["nodes"]})
    saved = bytes(Snapshot.objects.get(id=root["snapshot_id"]).canonical)
    changed = copy.deepcopy(cable)
    changed["assignments"][0]["contact_id"] = "b"
    updated = op(
        owner,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": changed},
        expected_state=frozen["draft"]["state"],
    )
    cable_capture(owner, updated)
    assert graph(owner, root) == result
    assert bytes(Snapshot.objects.get(id=root["snapshot_id"]).canonical) == saved


def test_unspecified_assembly_electrical_and_mating_are_boundaries(users, project):
    owner = users["owner"]
    body_revision = interface_freeze(owner, interface_create(owner, project))
    rel = {"a": {"path": ["left"], "feature_id": "a"}, "b": {"path": ["right"], "feature_id": "a"}}
    root = assembly(
        owner,
        project,
        [("left", body_revision), ("right", body_revision)],
        [
            {"local_id": "connection", "kind": "electrical", **rel},
            {"local_id": "mate", "kind": "mating", **rel},
        ],
    )
    result = graph(owner, root)
    assert len(result["nodes"]) == len(result["components"]) == 6
    assert result["edges"] == []
    assert {b["kind"] for b in result["boundaries"]} == {"assembly_electrical", "assembly_mating"}


def test_unknown_interface_passage_is_not_copper(users, project):
    setup = setup_mapping(users["owner"], project, internal_kind="connector_body")
    # Existing fixture returns a draft mapping plus the pinned source records.
    mapping = setup[-1]
    frozen = interface_freeze(users["owner"], interface_create(users["owner"], project, mapping))
    result = graph(users["owner"], frozen)
    assert result["edges"] == []
    assert {b["kind"] for b in result["boundaries"]} == {"interface_passage"}


def test_current_full_source_authority_precedes_selection_and_limits(users, project, monkeypatch):
    owner, user = users["owner"], users["editor"]
    stock, bundle = source_backed_stock(users, project)
    harness = {
        "sections": [{"local_id": "piece", "stock_revision_id": stock["revision_id"]}],
        "segments": [{"local_id": "run", "section_id": "piece"}],
    }
    frozen = capture(owner, create(owner, project, harness))
    root = assembly(owner, project, [("lead", frozen)])
    assert graph(user, root)["nodes"]
    hidden = op(owner, "project.create", {"name": "Restricted evidence"})["project_id"]
    bundle.project_id = hidden
    bundle.save(update_fields=["project"])
    monkeypatch.setattr("specmate.copper.queries.MAX_NODES", 0)
    for kwargs in ({}, {"occurrence_path": ["missing"]}, {"terminal_id": "missing"}):
        with pytest.raises(NotFound):
            graph(user, root, **kwargs)
    client = Client()
    client.force_login(user)
    response = client.get(f"/api/v0/copper/revisions/{root['revision_id']}")
    assert response.status_code == 404
    assert stock["revision_id"].encode() not in response.content


def test_cross_project_revocation_rechecks_whole_root_even_for_other_occurrence(users, project):
    owner, user = users["owner"], users["editor"]
    private = op(owner, "project.create", {"name": "Scoped source"})["project_id"]
    grant = Membership.objects.create(user=user, project_id=private, role="viewer")
    private_body = interface_freeze(owner, interface_create(owner, private))
    public_body = interface_freeze(owner, interface_create(owner, project))
    root = assembly(owner, project, [("visible", public_body), ("restricted", private_body)])
    assert graph(user, root, occurrence_path=["visible"])["nodes"]
    grant.delete()
    with pytest.raises(NotFound):
        graph(user, root, occurrence_path=["visible"])


def test_graph_limits_are_errors_without_partial_connectivity_claim(users, project, monkeypatch):
    owner = users["owner"]
    *_, cable = cable_fixture(owner, project)
    frozen = cable_capture(owner, cable_create(owner, project, cable))
    monkeypatch.setattr("specmate.copper.queries.MAX_NODES", 1)
    with pytest.raises(ValidationFailed, match="terminal limit"):
        graph(owner, frozen)
    monkeypatch.setattr("specmate.copper.queries.MAX_NODES", 20000)
    monkeypatch.setattr("specmate.copper.queries.MAX_RECORDS", 1)
    with pytest.raises(ValidationFailed, match="relationship limit"):
        graph(owner, frozen)


def test_operations_http_and_service_agree_and_do_not_store_replay(users, project):
    owner = users["owner"]
    body_revision = interface_freeze(owner, interface_create(owner, project))
    result = graph(owner, body_revision)
    assert result == inspect_graph(owner, ReadGraph(revision_id=body_revision["revision_id"]))
    assert graph(users["viewer"], body_revision) == result
    client = Client()
    client.force_login(owner)
    assert client.get(f"/api/v0/copper/revisions/{body_revision['revision_id']}").json() == result
    request = {
        "operation": "copper.graph",
        "request_id": "graph-read",
        "payload": {
            "revision_id": body_revision["revision_id"],
            "terminal_id": result["nodes"][0]["id"],
        },
    }
    response = client.post(
        "/api/v0/operations", data=json.dumps(request), content_type="application/json"
    )
    assert response.status_code == 200 and response.json()["result"]["selected_component_id"]
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "copper.graph",
            {"revision_id": body_revision["revision_id"]},
            idempotency_key="not-supported",
        )
    with pytest.raises(NotFound):
        graph(users["outsider"], body_revision)


def board_population(users, attempt):
    report = report_payload()
    components = []
    for ref in ("R1", "J1", "J2"):
        components.append(
            {
                "id": str(uuid4()),
                "reference": ref,
                "value": "100" if ref == "R1" else "connector",
                "footprint": "synthetic",
                "position": [0, 0],
                "rotation_deg": 0,
                "side": "front",
                "dnp": False,
                "exclude_from_bom": False,
            }
        )
    report["components"] = components
    report["pads"] = [
        {
            "id": str(uuid4()),
            "component_id": components[index]["id"],
            "number": number,
            "terminal": f"{components[index]['reference']}.{number}",
            "position": [0, 0],
            "size": [1, 1],
            "drill": [0, 0],
            "rotation_deg": 0,
            "type": "smd",
            "shape": "rect",
            "net": net,
            "layers": ["F.Cu"],
        }
        for index, number, net in [
            (0, "1", "left"),
            (0, "2", "right"),
            (1, "1", "left"),
            (2, "1", "right"),
        ]
    ]
    report["copper_nets"] = {"left": ["J1.1", "R1.1"], "right": ["J2.1", "R1.2"]}
    report["component_passages"] = [
        {"kind": "resistor", "from": "R1.1", "to": "R1.2", "resistance_ohm": 100}
    ]
    successful_output(attempt, report)
    interpretation = op(
        users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]}
    )
    draft = op(
        users["owner"],
        "pcb.population_create",
        {"interpretation_id": interpretation["interpretation_id"], "name": "Two-net board"},
    )
    return draft, report


def test_resistor_keeps_two_native_net_components_and_repeated_net_names_separate(
    users, project, request
):
    draft, report = board_population(users, request.getfixturevalue("pcb_attempt"))
    frozen = op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    result = graph(users["owner"], frozen)
    assert len(result["components"]) == 2
    assert all(
        len(c["members"]) == 2 and c["evidence"] == ["reported_net_membership"]
        for c in result["components"]
    )
    assert {e["provenance"]["native_net_name"] for e in result["edges"]} == {"left", "right"}
    resistor = next(b for b in result["boundaries"] if b["kind"] == "resistor")
    assert len(resistor["members"]) == 2 and resistor["status"] == "not_evaluated"
    assert component_for(result, pad_id=report["pads"][0]["id"]) != component_for(
        result, pad_id=report["pads"][1]["id"]
    )
    root = assembly(users["owner"], project, [("board-a", frozen), ("board-b", frozen)])
    repeated = graph(users["owner"], root)
    assert len(repeated["components"]) == 4
    assert len({n for c in repeated["components"] for n in c["native_net_ids"]}) == 4


def test_accepted_port_association_retains_provenance_without_copper_alias(users, project, request):
    from .test_interfaces import pinout

    owner = users["owner"]
    draft, report = board_population(users, request.getfixturevalue("pcb_attempt"))
    connector = interface_freeze(owner, interface_create(owner, project))
    pins = interface_freeze(owner, interface_create(owner, project, pinout(connector)))
    value = copy.deepcopy(draft["content"]["pcb_population"])
    value["associations"] = [
        {
            "local_id": "reviewed-port",
            "kind": "port",
            "component_id": report["pads"][2]["component_id"],
            "pad_id": report["pads"][2]["id"],
            "target_revision_id": pins["revision_id"],
            "target_contact_id": "a",
            "review": "accepted",
            "basis": "Synthetic reviewed assignment",
            "evidence": {"kind": "citation", "citation": "Synthetic contact table"},
        }
    ]
    updated = op(
        owner,
        "pcb.population_update",
        {"draft_id": draft["draft_id"], "population": value},
        expected_state=draft["state"],
    )
    frozen = op(
        owner,
        "pcb.population_freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=updated["state"],
    )
    result = graph(owner, frozen)
    assert len(result["nodes"]) == 4 and len(result["components"]) == 2
    boundary = next(b for b in result["boundaries"] if b["kind"] == "port_association")
    assert boundary["status"] == "not_evaluated"
    assert boundary["provenance"]["declaration"]["target_revision_id"] == pins["revision_id"]
    assert (
        boundary["provenance"]["declaration"]["evidence"]["citation"] == "Synthetic contact table"
    )


def test_preserved_source_rights_cannot_be_silently_reinterpreted(users, project):
    from django.db import IntegrityError, transaction

    from specmate.sources.models import SourceBundleFile

    stock, bundle = source_backed_stock(users, project)
    frozen = capture(
        users["owner"],
        create(
            users["owner"],
            project,
            {
                "sections": [{"local_id": "piece", "stock_revision_id": stock["revision_id"]}],
                "segments": [{"local_id": "span", "section_id": "piece"}],
            },
        ),
    )
    assert graph(users["owner"], frozen)["nodes"]
    before = graph(users["owner"], frozen)
    with pytest.raises(IntegrityError), transaction.atomic():
        SourceBundleFile.objects.filter(revision__bundle=bundle).update(rights="changed-rights")
    assert graph(users["owner"], frozen) == before


def test_source_closure_cap_is_bounded_and_explicit(users, project, monkeypatch):
    owner = users["owner"]
    body_revision = interface_freeze(owner, interface_create(owner, project))
    root = assembly(owner, project, [("first", body_revision)])
    monkeypatch.setattr("specmate.copper.queries.MAX_SNAPSHOTS", 1)
    with pytest.raises(ValidationFailed, match="source closure limit"):
        graph(owner, root)
