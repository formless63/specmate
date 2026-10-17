"""Synthetic wiring/material identities and independently counted physical inputs."""

import copy
from uuid import UUID

import pytest

from specmate.bom.contracts import BomPlan
from specmate.bom.queries import inspect_revision
from specmate.design.models import Revision
from specmate.interfaces import examples
from specmate.operations import Conflict, NotFound, ValidationFailed

from .conftest import op
from .test_bom import assembly, capture, policy
from .test_bom import create as create_bom
from .test_cable_end_stacks import kit as kit
from .test_cable_end_stacks import make_cable
from .test_inline_part_pins import catalog_part, pinned_end
from .test_interface_ports import create, freeze


@pytest.fixture
def bound(users, project, kit):
    owner = users["owner"]
    _, resistor = catalog_part(owner, project)
    _, screw = catalog_part(owner, project)
    end = freeze(owner, create(owner, project, pinned_end(kit, resistor["revision_id"])))
    cable = examples.av_demo_cable(kit["stock"], end["revision_id"], end["revision_id"])
    cable["assignments"] = [row for row in cable["assignments"] if row["endpoint_id"] == "b"]
    _, wiring = make_cable(owner, project, cable)
    parts = [
        ("resistor-a", resistor),
        ("resistor-b", resistor),
        *[(f"screw-{i}", screw) for i in range(4)],
    ]
    materials = assembly(owner, project, parts)
    root = assembly(owner, project, [("wiring", wiring), ("materials", materials)])
    binding = {
        "wiring_path": ["wiring"],
        "wiring_revision_id": wiring["revision_id"],
        "inputs_path": ["materials"],
        "inputs_revision_id": materials["revision_id"],
        "basis": "Independent material list: two resistors and four screws",
        "inline_parts": [
            {
                "endpoint_id": end_id,
                "layer_id": "inline",
                "part_local_id": "r1",
                "material_path": ["materials", "resistor-" + end_id],
            }
            for end_id in ("a", "b")
        ],
    }
    plan = {
        "assembly_revision_id": root["revision_id"],
        "quantity": {"status": "known", "amount": 2},
        "policies": [
            policy([], root, "make"),
            policy(["wiring"], wiring, "make"),
            policy(["materials"], materials, "make"),
            *[policy(["materials", name], rev, "buy") for name, rev in parts],
        ],
        "material_bindings": [binding],
    }
    return resistor, screw, wiring, materials, root, plan


def test_bound_quantities_are_counted_once_and_wiring_scope_includes_inputs(users, project, bound):
    owner = users["owner"]
    resistor, screw, _, _, _, plan = bound
    frozen = capture(owner, create_bom(owner, project, plan), "bom.freeze")
    view = inspect_revision(users["viewer"], frozen["revision_id"])
    assert len(view["rows"]) == 6
    assert (
        sum(
            r["quantity"]["amount"]
            for r in view["rows"]
            if r["revision_id"] == resistor["revision_id"]
        )
        == 4
    )
    assert (
        sum(
            r["quantity"]["amount"]
            for r in view["rows"]
            if r["revision_id"] == screw["revision_id"]
        )
        == 8
    )
    assert not {"inline_part_material_policy_unspecified", "make_inputs_unspecified"} & {
        r["reason"] for r in view["unresolved"]
    }
    assert all(r["waste_status"] == "not_evaluated" for r in view["rows"])
    contents = inspect_revision(owner, frozen["revision_id"], "assembly_contents")
    assert len(contents["rows"]) == 8
    assert not any(r["reason"] == "declared_inline_part" for r in contents["rows"])
    assert contents["material_bindings"][0]["basis"] == plan["material_bindings"][0]["basis"]
    plan["scope_paths"] = [["wiring"]]
    scoped = capture(owner, create_bom(owner, project, plan), "bom.freeze")
    assert len(inspect_revision(owner, scoped["revision_id"])["rows"]) == 6


@pytest.mark.parametrize(
    "change",
    [
        "wrong_part",
        "duplicate_target",
        "missing_inline",
        "stale_wiring",
        "stale_inputs",
        "buy_wiring",
        "wrong_quantity",
    ],
)
def test_wrong_material_bindings_rejected(users, project, bound, change):
    _, screw, wiring, _, _, plan = bound
    binding = plan["material_bindings"][0]
    if change == "wrong_part":
        binding["inline_parts"][0]["material_path"] = ["materials", "screw-0"]
    elif change == "duplicate_target":
        binding["inline_parts"][1]["material_path"] = binding["inline_parts"][0]["material_path"]
    elif change == "missing_inline":
        binding["inline_parts"].pop()
    elif change == "stale_wiring":
        binding["wiring_revision_id"] = screw["revision_id"]
    elif change == "stale_inputs":
        binding["inputs_revision_id"] = wiring["revision_id"]
    elif change == "buy_wiring":
        plan["policies"][1]["decision"] = "buy"
    else:
        plan["occurrence_demands"] = [
            {
                "path": ["materials", "resistor-a"],
                "revision_id": bound[0]["revision_id"],
                "quantity": {"status": "known", "amount": "2", "unit": "ea"},
                "basis": "Incorrect extra physical resistor",
            }
        ]
    with pytest.raises(ValidationFailed):
        create_bom(users["owner"], project, plan)


def test_binding_update_preserves_frozen_history_and_stale_cas(users, project, bound):
    owner, plan = users["owner"], bound[-1]
    draft = create_bom(owner, project, plan)
    frozen = capture(owner, draft, "bom.freeze")
    before = bytes(Revision.objects.get(id=frozen["revision_id"]).snapshot.canonical)
    revised = copy.deepcopy(plan)
    revised["material_bindings"][0]["basis"] = "Second reviewed declaration"
    changed = op(
        owner,
        "bom.update",
        {"draft_id": draft["draft_id"], "bom": revised},
        expected_state=frozen["draft"]["state"],
    )
    with pytest.raises(Conflict):
        op(
            owner,
            "bom.update",
            {"draft_id": draft["draft_id"], "bom": plan},
            expected_state=frozen["draft"]["state"],
        )
    capture(owner, changed, "bom.freeze")
    assert bytes(Revision.objects.get(id=frozen["revision_id"]).snapshot.canonical) == before


def test_foreign_material_closure_hidden(users, project, other_workspace, bound):
    _, foreign = catalog_part(users["outsider"], other_workspace)
    plan = bound[-1]
    plan["needs"] = [
        {
            "local_id": "foreign",
            "context_path": [],
            "revision_id": foreign["revision_id"],
            "purpose": "consumables",
            "basis": "Foreign pin stays hidden",
        }
    ]
    with pytest.raises(NotFound):
        create_bom(users["owner"], project, plan)


def test_legacy_bom_omits_unrecorded_material_bindings():
    original = {"assembly_revision_id": str(UUID(int=1))}
    native = BomPlan.model_validate(original)
    assert "material_bindings" not in native.model_dump(mode="json")
    assert native.model_dump(mode="json") == BomPlan.model_validate(
        {**original, "material_bindings": []}
    ).model_dump(mode="json")
