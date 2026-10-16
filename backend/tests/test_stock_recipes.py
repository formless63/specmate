"""Original arithmetic, immutable-pin and shared-authority recipe oracles."""

import copy
import json
from uuid import UUID

import pytest
from pydantic import ValidationError

from specmate.design.models import Draft, Snapshot
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.wire_stock.recipes import Binding, Constituent, StockRecipe, compile_stock

from .conftest import op
from .test_wire_stock import create, fixture


def fact(value, unit=None):
    return {
        "value": value,
        "unit": unit,
        "source": "Original synthetic specification" if value is not None else None,
        "status": "documented" if value is not None else "unknown",
    }


def constituent(users, workspace, value=1, actor="owner"):
    created = op(
        users[actor],
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "part",
            "name": "Synthetic reusable copper",
            "content": {
                "stock_constituent": {
                    "kind": "conductor",
                    "source": "Original synthetic specification",
                    "values": {
                        "outer_diameter_mm": fact(value, "mm"),
                        "strand_count": fact(7),
                        "strand_diameter_mm": fact(0.2, "mm"),
                    },
                }
            },
        },
    )
    return op(
        users[actor],
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )


def recipe(pin):
    return {
        "schema_version": "1",
        "source": "Original synthetic recipe",
        "template": fixture(),
        "constituents": [
            {
                "local_id": "copper",
                "revision_id": pin["revision_id"],
                "snapshot_sha256": pin["sha256"],
            }
        ],
        "bindings": [
            {
                "element_path": "stock.center",
                "target_field": "outer_diameter_mm",
                "formula": "identity",
                "inputs": [{"constituent_local_id": "copper", "field": "outer_diameter_mm"}],
            }
        ],
    }


def test_compile_replay_stale_rejection_frozen_history_and_reviewed_new_pin(users, workspace):
    copper = constituent(users, workspace)
    stock = create(users, workspace)
    first = op(
        users["owner"],
        "wire_stock.compile_recipe",
        {"draft_id": stock["draft_id"], "recipe": recipe(copper)},
        expected_state=stock["state"],
        idempotency_key="compile",
    )
    replay = op(
        users["owner"],
        "wire_stock.compile_recipe",
        {"draft_id": stock["draft_id"], "recipe": recipe(copper)},
        expected_state=stock["state"],
        idempotency_key="compile",
    )
    assert replay == first
    assert first["content"]["stock"]["structure"]["children"][0]["outer_diameter_mm"] == 1
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "wire_stock.compile_recipe",
            {"draft_id": stock["draft_id"], "recipe": recipe(copper)},
            expected_state=stock["state"],
        )
    frozen = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": stock["draft_id"]},
        expected_state=first["state"],
    )
    before = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    assert list(
        Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    ) == [UUID(copper["revision_id"])]
    newer = constituent(users, workspace, 0.8)
    latest = op(
        users["owner"],
        "wire_stock.compile_recipe",
        {"draft_id": stock["draft_id"], "recipe": recipe(newer)},
        expected_state=frozen["draft"]["state"],
    )
    assert latest["content"]["stock"]["structure"]["children"][0]["outer_diameter_mm"] == 0.8
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == before
    assert (
        json.loads(before)["content"]["stock_recipe"]["constituents"][0]["revision_id"]
        == copper["revision_id"]
    )


def test_unauthorized_foreign_hash_and_divergence_reject_without_writes(
    users, workspace, other_workspace
):
    pin = constituent(users, workspace)
    foreign = constituent(users, other_workspace, actor="outsider")
    stock = create(users, workspace)
    before = Draft.objects.get(id=stock["draft_id"]).content
    for actor, supplied, error in [
        ("viewer", recipe(pin), PermissionDenied),
        ("outsider", recipe(pin), NotFound),
        ("owner", recipe(foreign), NotFound),
    ]:
        with pytest.raises(error):
            op(
                users[actor],
                "wire_stock.compile_recipe",
                {"draft_id": stock["draft_id"], "recipe": supplied},
                expected_state=stock["state"],
            )
    corrupted = recipe(pin)
    corrupted["constituents"][0]["snapshot_sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "wire_stock.compile_recipe",
            {"draft_id": stock["draft_id"], "recipe": corrupted},
            expected_state=stock["state"],
        )
    assert Draft.objects.get(id=stock["draft_id"]).content == before
    first = op(
        users["owner"],
        "wire_stock.compile_recipe",
        {"draft_id": stock["draft_id"], "recipe": recipe(pin)},
        expected_state=stock["state"],
    )
    changed = copy.deepcopy(first["content"])
    changed["stock"]["structure"]["children"][0]["outer_diameter_mm"] = 0.9
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.update",
            {"draft_id": stock["draft_id"], "content": changed},
            expected_state=first["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "wire_stock.update",
            {"draft_id": stock["draft_id"], "stock": changed["stock"]},
            expected_state=first["state"],
        )


def test_pure_formulas_units_working_and_unknowns_are_independent():
    from uuid import UUID

    r = recipe({"revision_id": str(UUID(int=7)), "sha256": "a" * 64})
    r["bindings"] = [
        {
            "element_path": "stock.center",
            "target_field": "outer_diameter_mm",
            "formula": "stranded_diameter",
            "inputs": [
                {"constituent_local_id": "copper", "field": "strand_count"},
                {"constituent_local_id": "copper", "field": "strand_diameter_mm"},
            ],
        }
    ]
    material = Constituent.model_validate(
        {
            "kind": "conductor",
            "source": "Synthetic",
            "values": {"strand_count": fact(7), "strand_diameter_mm": fact(0.2, "mm")},
        }
    )
    result = compile_stock(StockRecipe.model_validate(r), {"copper": material})
    node = result["structure"]["children"][0]
    assert node["outer_diameter_mm"] == pytest.approx(0.6)
    assert node["facts"]["compiled_outer_diameter_mm"]["status"] == "inferred"
    material.values["strand_diameter_mm"] = __import__(
        "specmate.wire_stock.schemas", fromlist=["Fact"]
    ).Fact.model_validate(fact(None, "mm"))
    assert (
        compile_stock(StockRecipe.model_validate(r), {"copper": material})["structure"]["children"][
            0
        ]["outer_diameter_mm"]
        is None
    )
    with pytest.raises(ValidationError):
        Constituent.model_validate(
            {
                "kind": "conductor",
                "source": "Synthetic",
                "values": {"outer_diameter_mm": fact(2, "in")},
            }
        )
    with pytest.raises(ValidationError):
        Binding.model_validate({**r["bindings"][0], "formula": "eval"})


@pytest.mark.parametrize(
    "formula,target,fields,values,expected",
    [
        (
            "conductor_area",
            "area_mm2",
            ["strand_count", "strand_diameter_mm"],
            [fact(7), fact(0.2, "mm")],
            0.21991148575128555,
        ),
        (
            "over_layer_diameter",
            "outer_diameter_mm",
            ["outer_diameter_mm", "wall_mm"],
            [fact(1, "mm"), fact(0.15, "mm")],
            1.3,
        ),
        ("insulation_diameter", "insulated_diameter_mm", ["outer_diameter_mm"], [fact(2, "mm")], 2),
    ],
)
def test_formula_outputs_independent_of_display_and_source_stock(
    formula, target, fields, values, expected
):
    r = recipe({"revision_id": str(UUID(int=8)), "sha256": "a" * 64})
    r["bindings"] = [
        {
            "element_path": "stock.center",
            "target_field": target,
            "formula": formula,
            "inputs": [{"constituent_local_id": "copper", "field": field} for field in fields],
        }
    ]
    c = Constituent.model_validate(
        {
            "kind": "conductor",
            "source": "Original synthetic arithmetic",
            "values": dict(zip(fields, values, strict=True)),
        }
    )
    stock = compile_stock(StockRecipe.model_validate(r), {"copper": c})
    assert stock["structure"]["children"][0][target] == pytest.approx(expected)


def test_construction_bonds_require_conductive_exact_leaves_and_preserve_unknown():
    from specmate.wire_stock.schemas import StockSpecification

    original = fixture()
    assert "bonded_sets" not in StockSpecification.model_validate(original).model_dump(mode="json")
    original["bonded_sets"] = []
    assert StockSpecification.model_validate(original).model_dump(mode="json")["bonded_sets"] == []
    original["bonded_sets"] = [
        {
            "local_id": "common",
            "element_paths": ["stock.center", "stock.screen"],
            "basis": "Original synthetic construction",
        }
    ]
    StockSpecification.model_validate(original)
    original["bonded_sets"][0]["element_paths"][1] = "stock.dielectric"
    with pytest.raises(ValidationError):
        StockSpecification.model_validate(original)


def test_composite_constituent_pins_are_captured_and_http_compile_shares_command(users, workspace):
    from django.test import Client

    leaf = constituent(users, workspace)
    composite = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "part",
            "name": "Synthetic composite core",
            "content": {
                "stock_constituent": {
                    "kind": "core",
                    "values": {},
                    "source": "Original synthetic composite",
                    "components": [
                        {
                            "local_id": "center",
                            "revision_id": leaf["revision_id"],
                            "snapshot_sha256": leaf["sha256"],
                        }
                    ],
                }
            },
        },
    )
    frozen = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": composite["draft_id"]},
        expected_state=composite["state"],
    )
    assert list(
        Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    ) == [UUID(leaf["revision_id"])]
    stock = create(users, workspace)
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "wire_stock.compile_recipe",
                "request_id": "http-compile",
                "payload": {"draft_id": stock["draft_id"], "recipe": recipe(leaf)},
                "expected_state": stock["state"],
                "idempotency_key": "http-compile",
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    assert (
        response.json()["result"]["content"]["stock_recipe"]["constituents"][0]["revision_id"]
        == leaf["revision_id"]
    )
