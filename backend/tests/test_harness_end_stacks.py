"""CAB-002/CAB-005: harness endpoints are end stacks (harness content schema 0.2).

Expected values come from the synthetic tables in ``interfaces.examples`` (the board-form
console end: pad ``r`` -> straight copper -> reviewed landing -> plug contact 4) and from
the existing harness fixture, not from the implementation.
"""

import copy
import importlib
import json

import pytest
from django.apps import apps as django_apps

from specmate.design.models import Draft, Revision
from specmate.operations import ValidationFailed

from . import test_cable_end_stacks
from .conftest import op
from .scope_helpers import workspace_of
from .test_harnesses import create, fixture

kit = test_cable_end_stacks.kit


def freeze(user, draft):
    return op(
        user, "harness.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


def test_schema_0_1_input_is_stored_as_one_layer_connector_stacks(users, project):
    owner = users["owner"]
    _, body, pins, harness = fixture(owner, project)
    draft = create(owner, project, harness)
    stored = Draft.objects.get(id=draft["draft_id"]).content["harness"]
    assert stored["schema_version"] == "0.2"
    assert stored["endpoints"][0] == {
        "local_id": "input",
        "label": None,
        "end_assembly_revision_id": None,
        "stack": {
            "layers": [
                {
                    "kind": "connector",
                    "layer_id": "connector",
                    "body_revision_id": body["revision_id"],
                    "pinout_revision_id": pins["revision_id"],
                }
            ],
            "joins": [],
        },
    }
    land = next(j for j in stored["joints"] if j["local_id"] == "input-land")
    assert land["members"][1] == {
        "kind": "endpoint",
        "endpoint_id": "input",
        "layer_id": "connector",
        "terminal_id": "a",
    }


def test_frozen_schema_0_1_harness_stays_readable_and_unchanged(users, project):
    owner = users["owner"]
    _, body, _, harness = fixture(owner, project)
    draft = create(owner, project, harness)
    # Simulate content written before schema 0.2: the draft holds the old shape verbatim.
    Draft.objects.filter(id=draft["draft_id"]).update(content={"harness": harness})
    revision = freeze(owner, draft)["revision_id"]
    canonical = json.loads(bytes(Revision.objects.get(id=revision).snapshot.canonical))
    assert "schema_version" not in canonical["content"]["harness"]
    inspected = op(users["viewer"], "harness.read", {"revision_id": revision})
    assert inspected["stored_schema_version"] == "0.1"
    assert inspected["harness"]["schema_version"] == "0.2"
    view = inspected["endpoints"][0]["resolved_stack"]
    assert view["body_revision_id"] == body["revision_id"]
    contacts = [
        t["terminal"] for t in inspected["terminals"] if t["terminal"]["kind"] == "endpoint"
    ]
    assert {
        "kind": "endpoint",
        "endpoint_id": "input",
        "layer_id": "connector",
        "terminal_id": "a",
    } in contacts
    assert json.loads(bytes(Revision.objects.get(id=revision).snapshot.canonical)) == canonical


def test_draft_migration_upgrades_only_editable_0_1_harness_content(users, project):
    owner = users["owner"]
    _, _, _, harness = fixture(owner, project)
    draft = create(owner, project, harness)
    Draft.objects.filter(id=draft["draft_id"]).update(content={"harness": harness})
    version = Draft.objects.get(id=draft["draft_id"]).version
    migration = importlib.import_module("specmate.harnesses.migrations.0001_harness_content_0_2")
    migration.upgrade_drafts(django_apps, None)
    upgraded = Draft.objects.get(id=draft["draft_id"])
    assert upgraded.version == version + 1
    assert upgraded.content["harness"]["schema_version"] == "0.2"
    op(
        owner,
        "harness.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=f"draft-v{version + 1}",
    )


def stacked_harness(kit, member):
    return {
        "schema_version": "0.2",
        "sections": [{"local_id": "main", "stock_revision_id": kit["stock"]}],
        "segments": [{"local_id": "run", "section_id": "main"}],
        "endpoints": [
            {
                "local_id": "console",
                "label": "Console end",
                "end_assembly_revision_id": kit["end_a"],
            }
        ],
        "joints": [
            {
                "local_id": "red-land",
                "kind": "termination",
                "members": [
                    {
                        "kind": "segment",
                        "segment_id": "run",
                        "end": "a",
                        "element_path": "stock.core-1.center",
                    },
                    member,
                ],
                "basis": "Synthetic harness table",
            }
        ],
    }


def pad(terminal_id, layer_id="board"):
    return {
        "kind": "endpoint",
        "endpoint_id": "console",
        "layer_id": layer_id,
        "terminal_id": terminal_id,
    }


def test_harness_endpoint_pins_an_end_assembly_and_lands_on_a_board_pad(users, project, kit):
    owner = users["owner"]
    draft = op(
        owner,
        "harness.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Stacked harness",
            "harness": stacked_harness(kit, pad("r")),
        },
    )
    revision = freeze(owner, draft)["revision_id"]
    inspected = op(users["viewer"], "harness.read", {"revision_id": revision})
    end = inspected["endpoints"][0]
    assert end["end_assembly_name"] == "10-pin DIN plug + AV adapter board + shell"
    kinds = [layer["kind"] for layer in end["resolved_stack"]["layers"]]
    assert kinds == ["board", "connector", "shell"]
    records = {
        (t["terminal"].get("layer_id"), t["terminal"].get("terminal_id")): t
        for t in inspected["terminals"]
        if t["terminal"]["kind"] == "endpoint"
    }
    assert records[("board", "r")]["layer_kind"] == "board"
    assert records[("connector", "4")]["signal"]["name"] == "Red video"
    assert records[("shell", "body")]["feature_kind"] == "shell"

    graph = op(users["viewer"], "copper.graph", {"revision_id": revision})

    def node(**terminal):
        return next(
            n["id"]
            for n in graph["nodes"]
            if all(n["terminal"].get(k) == v for k, v in terminal.items())
        )

    def component(key):
        return next(c for c in graph["components"] if key in c["members"])

    wire = node(kind="segment", segment_id="run", end="a", element_path="stock.core-1.center")
    contact_4 = node(kind="endpoint", endpoint_id="console", contact_id="4")
    # Segment end -> pad r -> straight board copper -> reviewed landing -> contact 4.
    assert component(wire) == component(contact_4)
    shell = node(kind="stack_terminal", endpoint_id="console", layer_id="shell", terminal_id="body")
    assert component(shell)["members"] == [shell]


def test_endpoint_terminals_must_exist_on_their_layer(users, project, kit):
    owner = users["owner"]
    for member in (pad("nope"), pad("r", layer_id="missing")):
        with pytest.raises(ValidationFailed):
            op(
                owner,
                "harness.create",
                {
                    "workspace_id": workspace_of(project),
                    "name": "Bad harness",
                    "harness": stacked_harness(kit, member),
                },
            )
    both = copy.deepcopy(stacked_harness(kit, pad("r")))
    both["endpoints"][0]["stack"] = {"layers": [], "joins": []}
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "harness.create",
            {"workspace_id": workspace_of(project), "name": "Bad", "harness": both},
        )
