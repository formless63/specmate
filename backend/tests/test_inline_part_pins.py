"""Original synthetic exact provenance for explicitly authored two-lead inline uses."""

import json
from uuid import UUID

import pytest

from specmate.design.models import Revision
from specmate.interfaces import examples
from specmate.interfaces.end_assembly_contracts import InlinePart
from specmate.operations import NotFound, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_cable_end_stacks import kit as kit
from .test_cable_end_stacks import layer, make_cable
from .test_interface_ports import create, freeze


def catalog_part(user, scope, content=None):
    draft = op(
        user,
        "definition.create",
        {
            "workspace_id": workspace_of(scope),
            "kind": "part",
            "name": "Synthetic catalog identity",
            "content": content or {"package": "Declared multi-terminal package"},
        },
    )
    return draft, op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


def pinned_end(kit, revision):
    value = examples.rgb_inline_end(kit["rgb_plug"], kit["rgb_variant"], kit["hood"])
    value["stack"]["layers"][0]["parts"][0]["part_revision_id"] = revision
    return value


def test_unrecorded_inline_identity_keeps_literal_legacy_serialization():
    legacy = {
        "local_id": "r1",
        "component": {
            "kind": "resistor",
            "value": None,
            "reference": "R1",
            "resistance_ohm": "220",
            "capacitance_f": None,
        },
        "label": "Original synthetic resistor",
    }
    assert InlinePart.model_validate(legacy).model_dump(mode="json") == legacy
    assert (
        InlinePart.model_validate({**legacy, "part_revision_id": None}).model_dump(mode="json")
        == legacy
    )
    assert InlinePart.model_validate(
        {**legacy, "part_revision_id": "00000000-0000-0000-0000-000000000001"}
    ).model_dump(mode="json") == {
        **legacy,
        "part_revision_id": "00000000-0000-0000-0000-000000000001",
    }


def test_exact_part_provenance_never_changes_authored_behavior_or_asserts_package_pinout(
    users, project, kit
):
    owner = users["owner"]
    draft, first = catalog_part(owner, project)
    original = bytes(Revision.objects.get(id=first["revision_id"]).snapshot.canonical)
    changed = op(
        owner,
        "draft.update",
        {"draft_id": draft["draft_id"], "changes": {"package": "Different newer package"}},
        expected_state=first["draft"]["state"],
    )
    op(owner, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=changed["state"])
    end = create(owner, project, pinned_end(kit, first["revision_id"]))
    frozen = freeze(owner, end)
    result = op(users["viewer"], "interface.read", {"revision_id": frozen["revision_id"]})
    part = layer(result["end_stack"], "inline")["parts"][0]
    assert part["component"]["kind"] == "resistor"
    assert part["component"]["resistance_ohm"] == "220"
    assert part["part_identity"] == {
        "revision_id": first["revision_id"],
        "definition_id": draft["definition_id"],
        "name": "Synthetic catalog identity",
        "number": 1,
        "package_pinout": "not_evaluated",
        "declared_use": "two_lead_inline",
        "behavior_source": "separate_authored_component",
    }
    assert UUID(first["revision_id"]) in Revision.objects.get(
        id=frozen["revision_id"]
    ).snapshot.dependencies.values_list("revision_id", flat=True)
    assert bytes(Revision.objects.get(id=first["revision_id"]).snapshot.canonical) == original


def test_wrong_kind_and_foreign_inline_pins_fail_before_identity_disclosure(
    users, project, kit, other_workspace
):
    owner = users["owner"]
    with pytest.raises(ValidationFailed, match="exact Part"):
        create(owner, project, pinned_end(kit, kit["plug"]))
    _, foreign = catalog_part(users["outsider"], other_workspace)
    with pytest.raises(NotFound):
        create(owner, project, pinned_end(kit, foreign["revision_id"]))


def test_cable_pins_capture_each_authored_inline_part_and_legacy_end_bytes_stay_exact(
    users, project, kit
):
    owner = users["owner"]
    _, catalog = catalog_part(owner, project)
    old = Revision.objects.get(id=kit["end_b"])
    before = bytes(old.snapshot.canonical)
    value = examples.av_demo_cable(kit["stock"], kit["end_a"], kit["end_b"])
    value["endpoints"][1]["end_assembly_revision_id"] = None
    value["endpoints"][1]["stack"] = pinned_end(kit, catalog["revision_id"])["stack"]
    _, frozen = make_cable(owner, project, value)
    result = op(users["viewer"], "cable.read", {"revision_id": frozen["revision_id"]})
    assert (
        result["cable"]["endpoints"][1]["stack"]["layers"][0]["parts"][0]["part_revision_id"]
        == catalog["revision_id"]
    )
    assert UUID(catalog["revision_id"]) in Revision.objects.get(
        id=frozen["revision_id"]
    ).snapshot.dependencies.values_list("revision_id", flat=True)
    assert bytes(Revision.objects.get(id=old.id).snapshot.canonical) == before
    assert (
        json.loads(before)["content"]["interface"]["stack"]["layers"][0]["parts"][0].get(
            "part_revision_id"
        )
        is None
    )


@pytest.mark.parametrize("root_count", [3, None])
@pytest.mark.parametrize("root_decision", ["make", "unknown"])
def test_inline_bom_counts_repeated_saved_stacks_without_dimensional_parent_demand(
    users, project, kit, root_count, root_decision
):
    from specmate.bom.queries import inspect_revision

    from .test_bom import assembly, capture, policy
    from .test_bom import create as create_bom

    owner = users["owner"]
    _, catalog = catalog_part(owner, project)
    saved_end = freeze(owner, create(owner, project, pinned_end(kit, catalog["revision_id"])))
    cable = examples.av_demo_cable(kit["stock"], saved_end["revision_id"], saved_end["revision_id"])
    cable["assignments"] = [row for row in cable["assignments"] if row["endpoint_id"] == "b"]
    _, cable_revision = make_cable(owner, project, cable)
    root = assembly(owner, project, [("left", cable_revision), ("right", cable_revision)])
    plan = {
        "assembly_revision_id": root["revision_id"],
        "quantity": {"status": "known" if root_count else "unknown", "amount": root_count},
        "policies": [
            policy([], root, root_decision),
            policy(["left"], cable_revision, "make"),
            policy(["right"], cable_revision, "buy"),
        ],
        "occurrence_demands": [
            {
                "path": ["left"],
                "revision_id": cable_revision["revision_id"],
                "quantity": {"status": "known", "amount": "2000", "unit": "mm"},
                "basis": "Independent synthetic length demand",
            }
        ],
    }
    frozen = capture(owner, create_bom(owner, project, plan), "bom.freeze")
    before = bytes(Revision.objects.get(id=frozen["revision_id"]).snapshot.canonical)
    contents = inspect_revision(users["viewer"], frozen["revision_id"], "assembly_contents")
    inline = [row for row in contents["rows"] if row["reason"] == "declared_inline_part"]
    assert len(inline) == 4
    assert {
        (tuple(row["address"]["path"]), row["inline_part"]["endpoint_id"]) for row in inline
    } == {((side,), end) for side in ["left", "right"] for end in ["a", "b"]}
    assert {row["revision_id"] for row in inline} == {catalog["revision_id"]}
    assert all(
        row["quantity"]
        == {"status": "known" if root_count else "unknown", "amount": root_count, "unit": "ea"}
        for row in inline
    )
    assert all(
        row["per_root_quantity"] == {"status": "known", "amount": "1", "unit": "ea"}
        for row in inline
    )
    procurement = inspect_revision(users["viewer"], frozen["revision_id"], "procurement")
    assert [row["address"]["path"] for row in procurement["rows"]] == (
        [["right"]] if root_decision == "make" else []
    )
    needs = [
        row
        for row in procurement["unresolved"]
        if row["reason"] == "inline_part_material_policy_unspecified"
    ]
    if root_decision == "make":
        assert len(needs) == 2 and all(row["address"]["path"] == ["left"] for row in needs)
        assert {row["inline_part"]["endpoint_id"] for row in needs} == {"a", "b"}
        assert any(
            row["reason"] == "make_inputs_unspecified" and row["address"]["path"] == ["left"]
            for row in procurement["unresolved"]
        )
        assert any("procurement policy" in line for line in procurement["limitations"])
    else:
        assert not needs
        assert any(
            row["reason"] == "make_buy_unknown" and row["address"]["path"] == []
            for row in procurement["unresolved"]
        )
    assert procurement["status"] == "unknown"
    assert bytes(Revision.objects.get(id=frozen["revision_id"]).snapshot.canonical) == before


def test_harness_ad_hoc_stack_captures_exact_inline_part_dependency(users, project):
    from specmate.harnesses.contracts import Harness

    from .test_harnesses import capture, fixture
    from .test_harnesses import create as create_harness

    owner = users["owner"]
    _, catalog = catalog_part(owner, project)
    *_, value = fixture(owner, project)
    normalized = Harness.model_validate(value).model_dump(mode="json")
    normalized["endpoints"][0]["stack"]["layers"].insert(
        0,
        {
            "kind": "inline",
            "layer_id": "inline",
            "parts": [
                {
                    "local_id": "unknown-use",
                    "component": {"kind": "unknown"},
                    "part_revision_id": catalog["revision_id"],
                }
            ],
        },
    )
    frozen = capture(owner, create_harness(owner, project, normalized))
    inspected = op(users["viewer"], "harness.read", {"revision_id": frozen["revision_id"]})
    assert (
        inspected["harness"]["endpoints"][0]["stack"]["layers"][0]["parts"][0]["part_revision_id"]
        == catalog["revision_id"]
    )
    assert UUID(catalog["revision_id"]) in Revision.objects.get(
        id=frozen["revision_id"]
    ).snapshot.dependencies.values_list("revision_id", flat=True)


def test_current_inline_source_boundary_fences_resolve_save_replay_and_api_until_restored(
    users, project, kit, monkeypatch, client
):
    from specmate.cables import queries as cable_queries
    from specmate.design import operations as design_operations
    from specmate.harnesses import queries as harness_queries
    from specmate.operations import Conflict

    from .test_bom import assembly, policy
    from .test_bom import capture as freeze_bom
    from .test_bom import create as create_bom
    from .test_harnesses import capture as freeze_harness
    from .test_harnesses import create as create_harness

    owner = users["owner"]
    _, catalog = catalog_part(owner, project)
    value = pinned_end(kit, catalog["revision_id"])
    draft = create(owner, project, value, idempotency_key="inline-source")
    frozen = freeze(owner, draft)
    cable = examples.av_demo_cable(kit["stock"], kit["end_a"], frozen["revision_id"])
    _, cable_revision = make_cable(owner, project, cable)
    harness_revision = freeze_harness(
        owner,
        create_harness(
            owner,
            project,
            {"schema_version": "0.2", "endpoints": [{"local_id": "end", "stack": value["stack"]}]},
        ),
    )
    root = assembly(owner, project, [("cable", cable_revision), ("harness", harness_revision)])
    bom = freeze_bom(
        owner,
        create_bom(
            owner,
            project,
            {"assembly_revision_id": root["revision_id"], "policies": [policy([], root, "buy")]},
        ),
        "bom.freeze",
    )
    current = frozen["draft"]["state"]
    before = bytes(Revision.objects.get(id=frozen["revision_id"]).snapshot.canonical)
    with pytest.raises(Conflict):
        op(
            owner,
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": value},
            expected_state="stale",
        )
    assert bytes(Revision.objects.get(id=frozen["revision_id"]).snapshot.canonical) == before
    original = design_operations.authorize_snapshots
    denied = True

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        # Inject the real source-authority boundary; this is not a live grant-revocation test.
        if denied and any(str(row.pk) == catalog["snapshot_id"] for row in snapshots):
            raise NotFound("Synthetic current inline source boundary denied.")
        return original(user, snapshots, **kwargs)

    monkeypatch.setattr(design_operations, "authorize_snapshots", guard)
    monkeypatch.setattr(cable_queries, "authorize_snapshots", guard)
    monkeypatch.setattr(harness_queries, "authorize_snapshots", guard)
    for action in [
        lambda: op(users["viewer"], "end_assembly.resolve", {"stack": value["stack"]}),
        lambda: op(users["viewer"], "interface.read", {"revision_id": frozen["revision_id"]}),
        lambda: create(owner, project, value, idempotency_key="inline-source"),
        lambda: op(users["viewer"], "cable.read", {"revision_id": cable_revision["revision_id"]}),
        lambda: op(
            users["viewer"], "harness.read", {"revision_id": harness_revision["revision_id"]}
        ),
        lambda: op(users["viewer"], "bom.read", {"revision_id": bom["revision_id"]}),
        lambda: op(
            owner,
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": value},
            expected_state="stale",
        ),
    ]:
        with pytest.raises(NotFound):
            action()
    client.force_login(users["viewer"])
    body = {
        "operation": "end_assembly.resolve",
        "payload": {"stack": value["stack"]},
        "request_id": "inline-api",
    }
    response = client.post("/api/v0/operations", body, content_type="application/json")
    assert (
        response.status_code == 404
        and "Synthetic catalog identity" not in response.content.decode()
    )
    denied = False
    assert (
        client.post(
            "/api/v0/operations",
            {**body, "request_id": "inline-api-restored"},
            content_type="application/json",
        ).status_code
        == 200
    )
    assert (
        create(owner, project, value, idempotency_key="inline-source")["draft_id"]
        == draft["draft_id"]
    )
    assert frozen["draft"]["state"] == current
    assert bytes(Revision.objects.get(id=frozen["revision_id"]).snapshot.canonical) == before


def test_later_inline_adoption_keeps_retained_document_output_bytes_exact(users, project, kit):
    from .test_preparation_documents import configuration, files, retain

    owner = users["owner"]
    value = examples.av_demo_cable(kit["stock"], kit["end_a"], kit["end_b"])
    draft, first = make_cable(owner, project, value)
    config = configuration(first)
    _, receipt = retain(owner, config, "original-declared-inline")
    old_files = files(users["viewer"], receipt)
    snapshot = bytes(Revision.objects.get(id=first["revision_id"]).snapshot.canonical)
    _, catalog = catalog_part(owner, project)
    selected_end = freeze(owner, create(owner, project, pinned_end(kit, catalog["revision_id"])))
    value["endpoints"][1]["end_assembly_revision_id"] = selected_end["revision_id"]
    updated = op(
        owner,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": value},
        expected_state=first["draft"]["state"],
    )
    second = op(
        owner, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=updated["state"]
    )
    assert second["number"] == 2
    assert files(users["viewer"], receipt) == old_files
    assert bytes(Revision.objects.get(id=first["revision_id"]).snapshot.canonical) == snapshot
