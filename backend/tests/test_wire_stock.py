import json
from pathlib import Path

import pytest
from django.test import Client
from pydantic import ValidationError

from specmate.design.models import Definition, Draft, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.wire_stock.queries import get_stock, list_stocks
from specmate.wire_stock.schemas import StockSpecification, validate_stock_content

from .conftest import op

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"


def fixture(name="coax"):
    return json.loads((FIXTURES / f"wire-stock-{name}.json").read_text())["stock"]


def create(users, project, stock=None, **ctx):
    return op(
        users["owner"],
        "wire_stock.create",
        {
            "project_id": project,
            "name": "Synthetic standalone stock",
            "stock": fixture() if stock is None else stock,
        },
        **ctx,
    )


@pytest.mark.parametrize("name", ["coax", "pair", "ribbon", "figure-eight"])
def test_typed_construction_round_trip_preserves_hierarchy_and_unknowns(name, users, project):
    stock = fixture(name)
    record = create(users, project, stock)
    assert get_stock(users["viewer"], record["draft_id"])["content"]["stock"] == stock
    assert list_stocks(users["owner"], project)[0]["definition_id"] == record["definition_id"]
    assert Definition.objects.get(id=record["definition_id"]).kind == "wire_stock"
    assert stock["facts"]["impedance"] == {
        "value": None,
        "unit": "ohm",
        "source": None,
        "status": "unknown",
    }
    frozen = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": record["draft_id"]},
        expected_state=record["state"],
    )
    canonical = json.loads(bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical))
    assert canonical["content"]["stock"] == stock


def test_original_independent_coax_oracle_is_preserved():
    original = json.loads((FIXTURES / "stock-section.json").read_text())
    stock = StockSpecification.model_validate(fixture())
    leaves = stock.structure.children
    assert len(leaves) == original["expected"]["layer_count"] == 4
    for element, expected in zip(leaves, original["layers"], strict=True):
        assert element.id == expected["id"]
        assert element.kind == expected["kind"]
        assert element.inner_diameter_mm / 2 == expected["r_inner"]
        assert element.outer_diameter_mm / 2 == expected["r_outer"]
    assert leaves[-1].outer_diameter_mm == original["expected"]["outer_diameter_mm"]


def test_update_state_and_frozen_bytes(users, project):
    record = create(users, project)
    frozen = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": record["draft_id"]},
        expected_state=record["state"],
    )
    before = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    stock = fixture()
    stock["structure"]["children"][1]["outer_diameter_mm"] = None
    update = op(
        users["editor"],
        "wire_stock.update",
        {"draft_id": record["draft_id"], "stock": stock},
        expected_state=frozen["draft"]["state"],
    )
    assert update["state"] == "draft-v3"
    assert update["content"]["stock"]["structure"]["children"][1]["outer_diameter_mm"] is None
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == before
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "wire_stock.update",
            {"draft_id": record["draft_id"], "stock": stock},
            expected_state="draft-v1",
        )


def test_idempotency_replay_and_mismatch(users, project):
    first = create(users, project, idempotency_key="stock-create")
    assert create(users, project, idempotency_key="stock-create") == first
    assert Definition.objects.filter(kind="wire_stock").count() == 1
    with pytest.raises(IdempotencyMismatch):
        create(users, project, fixture("pair"), idempotency_key="stock-create")


def test_scope_permission_and_validation_leave_no_partial_stock(users, project):
    payload = {"project_id": project, "name": "Synthetic", "stock": fixture()}
    for actor, error in [("viewer", PermissionDenied), ("outsider", NotFound)]:
        with pytest.raises(error):
            op(users[actor], "wire_stock.create", payload)
    assert Definition.objects.count() == Draft.objects.count() == 0
    invalid = fixture()
    invalid["structure"]["children"][0]["outer_diameter_mm"] = -1
    with pytest.raises(ValidationFailed):
        create(users, project, invalid)
    assert Definition.objects.count() == Draft.objects.count() == 0
    record = create(users, project)
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "wire_stock.update",
            {"draft_id": record["draft_id"], "stock": fixture()},
            expected_state=record["state"],
        )
    with pytest.raises(NotFound):
        get_stock(users["outsider"], record["draft_id"])
    with pytest.raises(NotFound):
        list_stocks(users["outsider"], project)
    with pytest.raises(PermissionDenied):
        op(
            users["editor"],
            "wire_stock.freeze",
            {"draft_id": record["draft_id"]},
            expected_state=record["state"],
        )


def test_typed_validation_rejects_duplicate_ids_impossible_radii_and_false_known_facts():
    stock = fixture()
    stock["structure"]["children"][1]["id"] = "center"
    with pytest.raises(ValidationError):
        StockSpecification.model_validate(stock)
    stock = fixture()
    stock["structure"]["children"][0]["inner_diameter_mm"] = 1
    with pytest.raises(ValidationFailed):
        validate_stock_content({"stock": stock})
    stock = fixture()
    stock["facts"]["impedance"]["value"] = 50
    with pytest.raises(ValidationFailed):
        validate_stock_content({"stock": stock})
    stock = fixture()
    stock["structure"]["children"][0]["outer_diameter_mm"] = True
    with pytest.raises(ValidationFailed):
        validate_stock_content({"stock": stock})
    assert validate_stock_content({"unfinished": True}) == {"unfinished": True}


def test_http_operations_and_queries_share_stock_commands(users, project):
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "wire_stock.create",
                "request_id": "http-stock",
                "payload": {
                    "project_id": project,
                    "name": "HTTP synthetic stock",
                    "stock": fixture(),
                },
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    record = response.json()["result"]
    assert (
        client.get(f"/api/v0/stocks/{record['draft_id']}").json()["content"]["stock"] == fixture()
    )
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/stocks/{record['draft_id']}").status_code == 404
    assert client.get(f"/api/v0/projects/{project}/stocks").status_code == 404


def test_typed_freeze_requires_stock_but_generic_draft_can_be_incomplete(users, project):
    record = op(
        users["owner"],
        "definition.create",
        {"project_id": project, "kind": "wire_stock", "name": "Unfinished"},
    )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "wire_stock.freeze",
            {"draft_id": record["draft_id"]},
            expected_state=record["state"],
        )
    assert Snapshot.objects.count() == 0


def test_command_failure_rolls_back_definition_draft_and_idempotency(users, project, monkeypatch):
    from specmate.operations.models import IdempotencyRecord

    def fail_draft(*args, **kwargs):
        raise RuntimeError("Synthetic persistence interruption")

    monkeypatch.setattr(Draft.objects, "create", fail_draft)
    with pytest.raises(RuntimeError, match="Synthetic persistence"):
        create(users, project, idempotency_key="rollback-stock")
    assert Definition.objects.count() == 0
    assert Draft.objects.count() == 0
    assert not IdempotencyRecord.objects.filter(key="rollback-stock").exists()


@pytest.mark.django_db(transaction=True)
def test_competing_stock_edits_have_one_winner(users, project):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connections

    record = create(users, project)
    barrier = Barrier(2)

    def edit(color):
        close_old_connections()
        stock = fixture()
        stock["structure"]["children"][-1]["color"] = color
        barrier.wait(timeout=10)
        try:
            result = op(
                users["owner"],
                "wire_stock.update",
                {"draft_id": record["draft_id"], "stock": stock},
                expected_state=record["state"],
            )
            return result["state"]
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, ["#ff0000", "#0000ff"]))
    assert sorted(results) == ["conflict", "draft-v2"]
    assert Draft.objects.get(id=record["draft_id"]).version == 2


def test_committed_stock_schema_matches_authoritative_contract():
    from specmate.operations.management.commands.export_contract_schemas import render

    schema = FIXTURES.parents[1] / "contracts" / "schema" / "wire-stock.json"
    assert schema.read_text() == render(StockSpecification)


def test_generic_mutations_cannot_bypass_present_stock_validation(users, project):
    invalid = fixture()
    invalid["structure"]["children"][0]["outer_diameter_mm"] = -1
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "definition.create",
            {
                "project_id": project,
                "kind": "wire_stock",
                "name": "Invalid",
                "content": {"stock": invalid},
            },
        )
    assert not Definition.objects.exists()
    record = create(users, project)
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.update",
            {
                "draft_id": record["draft_id"],
                "changes": {"stock": invalid},
            },
            expected_state=record["state"],
        )
    assert get_stock(users["owner"], record["draft_id"])["state"] == record["state"]
    Draft.objects.filter(id=record["draft_id"]).update(content={"stock": invalid})
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {"draft_id": record["draft_id"]},
            expected_state=record["state"],
        )
    assert not Snapshot.objects.exists()


def test_stock_freeze_preserves_existing_exact_dependency_pins(users, project):
    record = create(users, project)
    child = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "part",
            "name": "Declared stock evidence",
        },
    )
    child_revision = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": child["draft_id"]},
        expected_state=child["state"],
    )
    first = op(
        users["owner"],
        "draft.freeze",
        {
            "draft_id": record["draft_id"],
            "dependencies": [child_revision["revision_id"]],
        },
        expected_state=record["state"],
    )
    second = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": record["draft_id"]},
        expected_state=first["draft"]["state"],
    )
    snapshot = Snapshot.objects.get(id=second["snapshot_id"])
    assert [str(rid) for rid in snapshot.dependencies.values_list("revision_id", flat=True)] == [
        child_revision["revision_id"],
    ]


def test_stock_key_namespace_and_current_edit_authority(users, project):
    from specmate.access.models import WorkspaceMember

    first = create(users, project, idempotency_key="same-stock-key")
    other = op(users["owner"], "project.create", {"name": "Separate stock project"})
    second = create(users, other["project_id"], idempotency_key="same-stock-key")
    assert first["definition_id"] != second["definition_id"]
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["owner"]).update(
        role="viewer"
    )
    with pytest.raises(PermissionDenied):
        create(users, project, idempotency_key="same-stock-key")
