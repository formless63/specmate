"""CAB-001/CAB-005: end assemblies and end stacks on cables (cable content schema 0.2).

Expected values are written from the synthetic fixtures' declared tables
(``interfaces.examples``), not read back from the implementation.
"""

import copy
import importlib
import json

import pytest
from django.apps import apps as django_apps

from specmate.design.models import Draft, Revision
from specmate.interfaces import examples
from specmate.operations import NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_interface_conventions import frozen_stock
from .test_interface_ports import create, freeze, frozen


def part(user, scope, name):
    draft = op(
        user,
        "definition.create",
        {"workspace_id": workspace_of(scope), "kind": "part", "name": name, "content": {}},
    )
    return op(user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"])[
        "revision_id"
    ]


@pytest.fixture
def kit(users, project):
    owner = users["owner"]
    signals = frozen(owner, project, examples.av_signal_set(), "Workshop AV signals")
    din = frozen(owner, project, examples.round_din_10_socket(), "10-pin round DIN socket")
    rgb = frozen(owner, project, examples.rgb_21_socket(), "21-pin RGB socket")
    plug = frozen(owner, project, examples.round_din_10_plug(din), "10-pin round DIN plug")
    rgb_plug = frozen(owner, project, examples.rgb_21_plug(rgb), "21-pin RGB plug")
    value = {
        "signals": signals,
        "plug": plug,
        "rgb_plug": rgb_plug,
        "plug_variant": frozen(
            owner,
            project,
            examples.console_pinout(signals, plug, "Console A AV"),
            "10-pin plug Console A AV",
        ),
        "rgb_variant": frozen(
            owner, project, examples.rgb_pinout(signals, rgb_plug, "sink"), "21-pin RGB input"
        ),
        "board": frozen(owner, project, examples.av_adapter_board(plug), "AV adapter board"),
        "shell": part(owner, project, "Small round overmould shell"),
        "hood": part(owner, project, "21-pin hood"),
        "stock": frozen_stock(owner, project),
    }
    value["end_a"] = frozen(
        owner,
        project,
        examples.din_adapter_end(value["board"], plug, value["plug_variant"], value["shell"]),
        "10-pin DIN plug + AV adapter board + shell",
    )
    value["end_b"] = frozen(
        owner,
        project,
        examples.rgb_inline_end(rgb_plug, value["rgb_variant"], value["hood"]),
        "21-pin RGB plug with inline blanking resistor + hood",
    )
    return value


def make_cable(user, scope, cable, name="Console to monitor cable"):
    draft = op(
        user,
        "cable.create",
        {"workspace_id": workspace_of(scope), "name": name, "cable": cable},
    )
    return draft, op(
        user, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


@pytest.fixture
def demo(users, project, kit):
    cable = examples.av_demo_cable(kit["stock"], kit["end_a"], kit["end_b"])
    return make_cable(users["owner"], project, cable)[1]["revision_id"]


def layer(view, layer_id):
    return next(layer for layer in view["layers"] if layer["layer_id"] == layer_id)


def terminal(view, layer_id, terminal_id):
    return next(t for t in layer(view, layer_id)["terminals"] if t["terminal_id"] == terminal_id)


def test_board_form_end_assembly_traverses_only_the_reviewed_landing(users, kit):
    view = op(users["viewer"], "interface.read", {"revision_id": kit["end_a"]})["end_stack"]
    assert [x["kind"] for x in view["layers"]] == ["board", "connector", "shell"]
    assert layer(view, "board")["carried_status"] == "reviewed"
    landings = [j for j in view["joins"] if j["kind"] == "carried"]
    # The board lands contacts 1-9 on the plug; nothing is joined by label.
    assert len(landings) == 9 and {j["status"] for j in landings} == {"reviewed"}
    red = terminal(view, "board", "r")["reaches"]
    assert [(r["contact_id"], r["status"]) for r in red] == [("4", "declared")]
    assert red[0]["signal"]["name"] == "Red video"
    assert red[0]["via"] == ["Straight copper", "landing"]
    sync = terminal(view, "board", "cs")["reaches"]
    assert sync[0]["contact_id"] == "1" and sync[0]["signal"]["name"] == "Composite sync"
    assert sync[0]["via"] == ["R1 470R resistor", "landing"]
    # The 5V pad has no declared path: it reaches nothing, which is not "unconnected".
    assert terminal(view, "board", "v5")["reaches"] == []
    shell = layer(view, "shell")
    assert shell["electrical"] == "none_unless_bonded"
    assert not [j for j in view["joins"] if "shell" in (j["a"]["layer_id"], j["b"]["layer_id"])]
    assert view["continuity"] == "not_evaluated"
    assert {n["layer_id"] for n in view["evaluation"]} == {"board", "shell"}


def test_inline_form_end_assembly_routes_through_the_part(users, kit):
    view = op(users["viewer"], "interface.read", {"revision_id": kit["end_b"]})["end_stack"]
    assert [x["kind"] for x in view["layers"]] == ["inline", "connector", "shell"]
    lead = terminal(view, "inline", "r1.1")
    assert lead["label"] == "Blanking resistor · 1"
    assert lead["reaches"] == [
        {
            "contact_id": "16",
            "label": "16",
            "signal": lead["reaches"][0]["signal"],
            "status": "declared",
            "via": ["R1 220R resistor", "solder"],
        }
    ]
    assert lead["reaches"][0]["signal"]["name"] == "RGB blanking"
    bond = next(j for j in view["joins"] if j["kind"] == "bond")
    assert (bond["a"]["terminal_id"], bond["b"]["label"]) == ("shell", "Shell body")
    # Connector contacts carry their pin signal directly.
    assert terminal(view, "connector", "15")["signal"]["name"] == "Red video"


def test_resolve_previews_an_ad_hoc_stack_and_rejects_foreign_pins(users, kit, workspace):
    stack = examples.din_adapter_end(kit["board"], kit["plug"], kit["plug_variant"])["stack"]
    view = op(users["contributor"], "end_assembly.resolve", {"stack": stack})
    assert view["end_assembly_revision_id"] is None
    assert terminal(view, "board", "g")["reaches"][0]["contact_id"] == "6"
    pinned = op(users["viewer"], "end_assembly.resolve", {"end_assembly_revision_id": kit["end_a"]})
    assert pinned["name"] == "10-pin DIN plug + AV adapter board + shell r1"
    with pytest.raises(NotFound):
        op(users["outsider"], "end_assembly.resolve", {"stack": stack})


def test_stack_declarations_are_checked_against_exact_pins(users, project, kit):
    owner = users["owner"]
    end = examples.din_adapter_end(kit["board"], kit["plug"], kit["plug_variant"])
    wrong = copy.deepcopy(end)
    # The board carries the 10-pin plug; another connector body cannot be its landing.
    wrong["stack"]["layers"][1]["body_revision_id"] = kit["rgb_plug"]
    wrong["stack"]["layers"][1]["pinout_revision_id"] = kit["rgb_variant"]
    with pytest.raises(ValidationFailed, match="carried connector"):
        create(owner, project, wrong)
    unknown = copy.deepcopy(end)
    unknown["stack"]["layers"][0]["carried_connector_id"] = "missing"
    with pytest.raises(ValidationFailed, match="carried connector"):
        create(owner, project, unknown)
    shell_solder = examples.rgb_inline_end(kit["rgb_plug"], kit["rgb_variant"])
    shell_solder["stack"]["joins"][1]["kind"] = "solder"
    with pytest.raises(ValidationFailed):
        create(owner, project, shell_solder)
    missing_pad = examples.rgb_inline_end(kit["rgb_plug"], kit["rgb_variant"])
    missing_pad["stack"]["joins"][0]["a"]["terminal_id"] = "r1.3"
    with pytest.raises(ValidationFailed, match="terminal"):
        create(owner, project, missing_pad)


def test_cable_ends_pin_assemblies_and_land_on_layer_terminals(users, demo):
    inspected = op(users["viewer"], "cable.read", {"revision_id": demo})
    assert inspected["stored_schema_version"] == "0.2"
    a, b = inspected["endpoints"]
    assert (a["stock_end"], b["stock_end"]) == ("a", "b")
    assert a["end_assembly_name"] == "10-pin DIN plug + AV adapter board + shell"
    # Connector-only consumers read the connector layer as before.
    assert a["body"]["family"] == "10-pin round DIN" and a["pinout"]["variant_label"]
    rows = {(t["endpoint_id"], t["element_path"]): t for t in inspected["terminations"]}
    red_a = rows["a", "stock.core-1.center"]
    assert (red_a["layer_kind"], red_a["terminal_label"], red_a["contact_id"]) == (
        "board",
        "R",
        None,
    )
    assert red_a["reaches"][0]["contact_id"] == "4"
    red_b = rows["b", "stock.core-1.center"]
    assert (red_b["contact_id"], red_b["signal"]["name"]) == ("15", "Red video")
    # Several screens may land on one ground pad.
    grounds = [k for k, t in rows.items() if k[0] == "a" and t["terminal_id"] == "gnd"]
    assert len(grounds) == 4
    # The blanking resistor's cable-side lead stays unterminated: no conductor for it.
    assert not [t for t in inspected["terminations"] if t["layer_id"] == "inline"]
    assert inspected["continuity"] == "not_evaluated"


def test_copper_graph_follows_conductor_to_pad_board_path_and_contact(users, demo):
    graph = op(users["viewer"], "copper.graph", {"revision_id": demo})

    def node(**terminal):
        return next(
            n["id"]
            for n in graph["nodes"]
            if all(n["terminal"].get(k) == v for k, v in terminal.items())
        )

    def component(key):
        return next(c for c in graph["components"] if key in c["members"])

    red_a = node(kind="cable_conductor", endpoint_id="a", element_path="stock.core-1.center")
    contact_4 = node(kind="endpoint", endpoint_id="a", contact_id="4")
    contact_15 = node(kind="endpoint", endpoint_id="b", contact_id="15")
    # Conductor -> pad R -> straight board copper -> reviewed landing -> contact 4, and on
    # to contact 15 at the other end: declared copper only.
    assert component(red_a) == component(contact_4) == component(contact_15)
    # The sync resistor and the inline part stay boundaries; they never merge copper.
    sync = node(kind="cable_conductor", endpoint_id="a", element_path="stock.core-4.center")
    assert component(sync) != component(node(kind="endpoint", endpoint_id="a", contact_id="1"))
    lead = node(kind="stack_terminal", endpoint_id="b", layer_id="inline", terminal_id="r1.1")
    assert component(lead) != component(node(kind="endpoint", endpoint_id="b", contact_id="16"))
    kinds = {b["kind"] for b in graph["boundaries"]}
    assert {"resistor"} <= kinds
    # The end A shell has no bond: its body joins nothing. The hood is bonded explicitly.
    shell = node(kind="stack_terminal", endpoint_id="a", layer_id="shell", terminal_id="body")
    assert component(shell)["members"] == [shell]
    hood = node(kind="stack_terminal", endpoint_id="b", layer_id="hood", terminal_id="body")
    assert node(kind="endpoint", endpoint_id="b", contact_id="shell") in component(hood)["members"]
    assert any(e["kind"] == "shield_bond" and hood in e["members"] for e in graph["edges"])


def test_unreviewed_board_landing_reads_unknown(users, project, kit):
    owner = users["owner"]
    board = examples.av_adapter_board(kit["plug"])
    board["carried_connectors"][0]["review"] = "unreviewed"
    del board["carried_connectors"][0]["basis"]
    unreviewed = frozen(owner, project, board, "Unreviewed adapter board")
    stack = examples.din_adapter_end(unreviewed, kit["plug"], kit["plug_variant"])["stack"]
    view = op(owner, "end_assembly.resolve", {"stack": stack})
    assert layer(view, "board")["carried_status"] == "unknown"
    assert {r["status"] for r in terminal(view, "board", "r")["reaches"]} == {"unknown"}
    cable = examples.av_demo_cable(kit["stock"], kit["end_a"], kit["end_b"])
    cable["endpoints"][0] = {"local_id": "a", "stock_end": "a", "stack": stack}
    revision = make_cable(owner, project, cable)[1]["revision_id"]
    graph = op(owner, "copper.graph", {"revision_id": revision})
    landings = [b for b in graph["boundaries"] if b["kind"] == "carried_connector_correspondence"]
    assert landings and {b["status"] for b in landings} == {"unknown"}


def test_cable_shape_rules(users, project, kit):
    owner = users["owner"]
    base = examples.av_demo_cable(kit["stock"], kit["end_a"], kit["end_b"])
    same_end = copy.deepcopy(base)
    same_end["endpoints"][1]["stock_end"] = "a"
    with pytest.raises(ValidationFailed):
        make_cable(owner, project, same_end)
    both = copy.deepcopy(base)
    both["endpoints"][0]["stack"] = {"layers": [{"kind": "shell", "layer_id": "shell"}]}
    with pytest.raises(ValidationFailed):
        make_cable(owner, project, both)
    bad_target = copy.deepcopy(base)
    bad_target["assignments"][0]["terminal_id"] = "zz"
    with pytest.raises(ValidationFailed, match="termination"):
        make_cable(owner, project, bad_target)
    not_assembly = copy.deepcopy(base)
    not_assembly["endpoints"][0]["end_assembly_revision_id"] = kit["board"]
    with pytest.raises(ValidationFailed, match="end assembly"):
        make_cable(owner, project, not_assembly)


def legacy_cable(kit):
    """Schema 0.1 content: one 21-pin plug per end, terminations to contacts."""
    end = {"body_revision_id": kit["rgb_plug"], "pinout_revision_id": kit["rgb_variant"]}
    return {
        "stock_revision_id": kit["stock"],
        "endpoints": [{"local_id": "a", "label": "Left", **end}, {"local_id": "b", **end}],
        "assignments": [
            {
                "endpoint_id": side,
                "element_path": "stock.core-1.center",
                "contact_id": "15",
                "basis": "Synthetic legacy table",
            }
            for side in ("a", "b")
        ],
    }


EXPECTED_UPGRADE_END = {
    "stock_end": "unknown",
    "end_assembly_revision_id": None,
    "stack": {
        "layers": [
            {
                "kind": "connector",
                "layer_id": "connector",
                "body_revision_id": None,
                "pinout_revision_id": None,
            }
        ],
        "joins": [],
    },
}


def test_schema_0_1_input_is_stored_as_a_one_layer_connector_stack(users, project, kit):
    draft, _ = make_cable(users["owner"], project, legacy_cable(kit))
    stored = Draft.objects.get(id=draft["draft_id"]).content["cable"]
    assert stored["schema_version"] == "0.2"
    expected = copy.deepcopy(EXPECTED_UPGRADE_END)
    expected["stack"]["layers"][0].update(
        body_revision_id=kit["rgb_plug"], pinout_revision_id=kit["rgb_variant"]
    )
    assert stored["endpoints"][0] == {"local_id": "a", "label": "Left", **expected}
    assert stored["assignments"][0] == {
        "endpoint_id": "a",
        "element_path": "stock.core-1.center",
        "layer_id": "connector",
        "terminal_id": "15",
        "basis": "Synthetic legacy table",
    }


def test_frozen_schema_0_1_revision_stays_readable_and_unchanged(users, project, kit):
    owner = users["owner"]
    draft = op(
        owner,
        "cable.create",
        {"workspace_id": workspace_of(project), "name": "Legacy", "cable": legacy_cable(kit)},
    )
    # Simulate content written before schema 0.2: the draft holds the old shape verbatim.
    Draft.objects.filter(id=draft["draft_id"]).update(content={"cable": legacy_cable(kit)})
    revision = op(
        owner, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )["revision_id"]
    canonical = json.loads(bytes(Revision.objects.get(id=revision).snapshot.canonical))
    assert "schema_version" not in canonical["content"]["cable"]
    inspected = op(users["viewer"], "cable.read", {"revision_id": revision})
    assert inspected["stored_schema_version"] == "0.1"
    assert inspected["cable"]["schema_version"] == "0.2"
    assert inspected["terminations"][0]["contact_id"] == "15"
    assert inspected["endpoints"][0]["body_revision_id"] == kit["rgb_plug"]
    # Reading never rewrites the frozen bytes.
    after = json.loads(bytes(Revision.objects.get(id=revision).snapshot.canonical))
    assert after == canonical


def test_draft_migration_upgrades_only_editable_0_1_cable_content(users, project, kit):
    owner = users["owner"]
    draft = op(
        owner,
        "cable.create",
        {"workspace_id": workspace_of(project), "name": "Legacy", "cable": legacy_cable(kit)},
    )
    Draft.objects.filter(id=draft["draft_id"]).update(content={"cable": legacy_cable(kit)})
    version = Draft.objects.get(id=draft["draft_id"]).version
    _, frozen_revision = make_cable(owner, project, legacy_cable(kit), "Frozen")
    snapshot = bytes(Revision.objects.get(id=frozen_revision["revision_id"]).snapshot.canonical)
    migration = importlib.import_module("specmate.cables.migrations.0001_cable_content_0_2")
    migration.upgrade_drafts(django_apps, None)
    upgraded = Draft.objects.get(id=draft["draft_id"])
    assert upgraded.version == version + 1
    assert upgraded.content["cable"]["schema_version"] == "0.2"
    assert upgraded.content["cable"]["assignments"][1]["terminal_id"] == "15"
    # Already-0.2 drafts and frozen snapshots are untouched.
    assert bytes(Revision.objects.get(id=frozen_revision["revision_id"]).snapshot.canonical) == (
        snapshot
    )
    # The upgraded draft still freezes.
    op(
        owner,
        "cable.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=f"draft-v{version + 1}",
    )


def test_changing_an_end_assembly_is_an_end_stack_change(users, project, kit, demo):
    owner = users["owner"]
    cable = examples.av_demo_cable(kit["stock"], kit["end_a"], kit["end_b"])
    draft = op(
        owner, "cable.create", {"workspace_id": workspace_of(project), "name": "C", "cable": cable}
    )
    first = op(
        owner, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    changed = copy.deepcopy(cable)
    changed["endpoints"][0]["stock_end"] = "unknown"
    state = Draft.objects.get(id=draft["draft_id"]).state_token
    updated = op(
        owner,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": changed},
        expected_state=state,
    )
    second = op(
        owner, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=updated["state"]
    )
    impact = op(
        users["viewer"],
        "cable.length_impact",
        {"before_revision_id": first["revision_id"], "after_revision_id": second["revision_id"]},
    )
    assert [s["section"] for s in impact["sections"]] == ["connectors"]
    assert impact["preparation_review_required"] is True


def test_end_assembly_is_a_workspace_item_freezable_by_editors(users, project, kit):
    stack = examples.rgb_inline_end(kit["rgb_plug"], kit["rgb_variant"])
    draft = create(users["contributor"], project, stack, "Contributor end")
    assert draft["state"]
    with pytest.raises(PermissionDenied):
        freeze(users["viewer"], draft)
