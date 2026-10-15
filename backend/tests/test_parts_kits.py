"""Authored descriptions, exact catalog groupings and generic operation authority."""

import json

import pytest
from django.core import signing
from django.db import connection
from django.test.utils import CaptureQueriesContext

from specmate.design import operations as design_operations
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
)
from specmate.parts import membership
from specmate.parts.contracts import KitPage
from specmate.queries import get_revision

from .conftest import ensure_member, member, op, remove_member
from .test_design import freeze
from .test_transports import api, post_op


def create(user, workspace, kind="part", content=None, **ctx):
    return op(
        user,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": kind,
            "name": f"Synthetic {kind}",
            "content": content or {},
        },
        **ctx,
    )


def part(**changes):
    return {
        "schema_version": "1",
        "category": "resistor",
        "value": "10 kΩ",
        "package": "0603",
        "fits": [],
        **changes,
    }


def kit(revision, **line):
    return {
        "schema_version": "1",
        "semantics": "catalog_grouping",
        "lines": [
            {"local_id": "part-1", "revision_id": revision["revision_id"], "quantity": None, **line}
        ],
    }


def frozen(user, draft):
    return freeze(user, draft["draft_id"], draft["state"])


def test_part_opt_in_preserves_legacy_shapes_and_freezes_authored_value_package(users, workspace):
    owner = users["owner"]
    legacy = {
        "value": "old authored text",
        "part": {"custom": [1, None]},
        "extra": {"arbitrary": True},
    }
    draft = create(owner, workspace, content=legacy)
    old = frozen(owner, draft)
    before = bytes(Snapshot.objects.get(id=old["snapshot_id"]).canonical)
    updated = op(
        owner,
        "draft.update",
        {"draft_id": draft["draft_id"], "changes": {"part": part()}},
        expected_state=old["draft"]["state"],
    )
    current = frozen(owner, {**draft, **updated})
    body = json.loads(bytes(Snapshot.objects.get(id=current["snapshot_id"]).canonical))
    assert body["content"] == {**legacy, "part": part()}
    assert body["dependencies"] == []
    assert bytes(Snapshot.objects.get(id=old["snapshot_id"]).canonical) == before
    get_revision(users["viewer"], old["revision_id"])
    assert json.loads(before)["content"] == legacy
    assert (
        post_op(
            api(users["viewer"]),
            "definition.create",
            {
                "workspace_id": workspace,
                "kind": "part",
                "name": "Denied",
                "content": {"part": part()},
            },
        ).status_code
        == 403
    )


def test_kit_freezes_exact_grouping_lines_without_physical_or_bom_state_and_retains_cas(
    users, workspace
):
    owner = users["owner"]
    target = frozen(owner, create(owner, workspace, content={"part": part()}))
    grouping = create(owner, workspace, "kit", {"kit": kit(target)}, idempotency_key="kit-create")
    retained = frozen(owner, grouping)
    snapshot = Snapshot.objects.get(id=retained["snapshot_id"])
    body = json.loads(bytes(snapshot.canonical))
    assert body["content"]["kit"]["semantics"] == "catalog_grouping"
    assert body["content"]["kit"]["lines"][0]["quantity"] is None
    assert [str(row.revision_id) for row in snapshot.dependencies.all()] == [target["revision_id"]]
    changed = kit(target, quantity={"amount": "2", "unit": "ea"})
    updated = op(
        owner,
        "draft.update",
        {"draft_id": grouping["draft_id"], "changes": {"kit": changed}},
        expected_state=retained["draft"]["state"],
    )
    with pytest.raises(Conflict):
        op(
            owner,
            "draft.update",
            {"draft_id": grouping["draft_id"], "changes": {"kit": kit(target)}},
            expected_state=retained["draft"]["state"],
        )
    assert updated["content"]["kit"]["lines"][0]["quantity"] == {"amount": "2", "unit": "ea"}
    assert json.loads(bytes(snapshot.canonical)) == body
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "draft.freeze",
            {"draft_id": grouping["draft_id"]},
            expected_state=updated["state"],
        )
    response = api(users["viewer"]).get(f"/api/v0/catalog/revisions/{target['revision_id']}/kits")
    assert response.status_code == 200
    result = response.json()
    assert result["results"][0]["revision_id"] == retained["revision_id"]
    assert result["results"][0]["lines"][0]["quantity"] is None
    assert result["physical_assembly"] == "not_implied" and "total" not in result


@pytest.mark.parametrize(
    "quantity",
    [
        {"amount": 0, "unit": "ea"},
        {"amount": -1, "unit": "m"},
        {"amount": "1.5", "unit": "ea"},
        {"amount": 1.2, "unit": "m"},
        {"amount": "1", "unit": "unsupported"},
    ],
)
def test_invalid_kit_quantity_is_rejected_atomically_in_shared_command(users, workspace, quantity):
    target = frozen(users["owner"], create(users["owner"], workspace))
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], workspace, "kit", {"kit": kit(target, quantity=quantity)})
    assert Definition.objects.count() == before


def test_nested_kits_and_foreign_pins_reject_before_capture(users, workspace, other_workspace):
    owner = users["owner"]
    target = frozen(owner, create(owner, workspace))
    grouping = frozen(owner, create(owner, workspace, "kit", {"kit": kit(target)}))
    with pytest.raises(ValidationFailed, match="Nested kit"):
        create(owner, workspace, "kit", {"kit": kit(grouping)})
    foreign = frozen(users["outsider"], create(users["outsider"], other_workspace))
    member(owner, "editor", workspace=other_workspace)
    for content in (
        {
            "part": part(
                fits=[{"revision_id": foreign["revision_id"], "basis": "Explicit synthetic target"}]
            )
        },
        {"kit": kit(foreign)},
    ):
        with pytest.raises(NotFound):
            create(owner, workspace, "kit" if "kit" in content else "part", content)


def test_declared_fit_pins_and_replay_recheck_current_source_closure_before_diagnostics(
    users, workspace, monkeypatch
):
    owner = users["owner"]
    target = frozen(owner, create(owner, workspace))
    content = {
        "part": part(
            fits=[
                {
                    "revision_id": target["revision_id"],
                    "basis": "Authored declaration; physical fit not evaluated",
                }
            ]
        )
    }
    draft = create(owner, workspace, content=content, idempotency_key="part-fit")
    retained = frozen(owner, draft)
    assert [
        str(row.revision_id)
        for row in Snapshot.objects.get(id=retained["snapshot_id"]).dependencies.all()
    ] == [target["revision_id"]]
    original = design_operations.authorize_snapshots
    denied = True

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        # Deliberately injected current source-closure boundary, not a pretend project ACL.
        if denied and any(str(snapshot.pk) == target["snapshot_id"] for snapshot in snapshots):
            raise NotFound("Current synthetic source closure unavailable.")
        return original(user, snapshots, **kwargs)

    monkeypatch.setattr(design_operations, "authorize_snapshots", guard)
    with pytest.raises(NotFound):
        create(owner, workspace, content={"changed": True}, idempotency_key="part-fit")
    with pytest.raises(NotFound):
        op(
            owner,
            "draft.update",
            {"draft_id": draft["draft_id"], "changes": {}},
            expected_state="wrong-state",
        )
    with pytest.raises(NotFound):
        get_revision(users["viewer"], retained["revision_id"])
    denied = False
    assert (
        create(owner, workspace, content=content, idempotency_key="part-fit")["definition_id"]
        == draft["definition_id"]
    )
    assert str(get_revision(users["viewer"], retained["revision_id"]).id) == retained["revision_id"]


def test_membership_scans_are_signed_root_bound_hide_denied_candidates_and_restore(
    users, workspace, monkeypatch
):
    owner = users["owner"]
    target = frozen(owner, create(owner, workspace))
    secret = frozen(owner, create(owner, workspace))
    fitted = frozen(
        owner,
        create(
            owner,
            workspace,
            content={
                "part": part(
                    fits=[{"revision_id": secret["revision_id"], "basis": "Synthetic declaration"}]
                )
            },
        ),
    )
    before = frozen(owner, create(owner, workspace, "kit", {"kit": kit(target)}))
    hidden_content = kit(target)
    hidden_content["lines"].append(
        {
            "local_id": "dependent",
            "revision_id": fitted["revision_id"],
            "quantity": {"amount": "12.25", "unit": "cm"},
        }
    )
    hidden = frozen(owner, create(owner, workspace, "kit", {"kit": hidden_content}))
    newest = frozen(owner, create(owner, workspace, "kit", {"kit": kit(target)}))
    original = design_operations.authorize_snapshots
    blocked = True

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        if blocked and any(str(row.pk) == secret["snapshot_id"] for row in snapshots):
            raise NotFound("Synthetic dependent source unavailable.")
        return original(user, snapshots, **kwargs)

    monkeypatch.setattr(design_operations, "authorize_snapshots", guard)
    monkeypatch.setattr(membership, "SCAN_LIMIT", 2)
    first = membership.kits_for_revision(users["viewer"], target["revision_id"], KitPage(limit=2))
    assert [row["revision_id"] for row in first["results"]] == [newest["revision_id"]]
    cursor = signing.loads(first["next_after"], salt=membership.SALT)
    assert set(cursor) == {"version", "root", "actor", "workspace", "anchor", "offset"}
    assert hidden["revision_id"] not in json.dumps(cursor)
    from specmate.design.models import Revision

    assert Revision.objects.get(id=hidden["revision_id"]).frozen_at.isoformat() not in json.dumps(
        cursor
    )
    assert cursor["offset"] == 2
    second = membership.kits_for_revision(
        users["viewer"], target["revision_id"], KitPage(limit=2, after=first["next_after"])
    )
    assert second["results"][0]["revision_id"] == before["revision_id"]
    assert second["next_after"] is None
    for cursor_value in (
        first["next_after"] + "x",
        signing.dumps({**cursor, "version": 2}, salt=membership.SALT),
        signing.dumps({**cursor, "root": secret["revision_id"]}, salt=membership.SALT),
        signing.dumps({**cursor, "actor": str(owner.id)}, salt=membership.SALT),
        signing.dumps({**cursor, "workspace": "different"}, salt=membership.SALT),
    ):
        with pytest.raises(ValidationFailed):
            membership.kits_for_revision(
                users["viewer"], target["revision_id"], KitPage(after=cursor_value)
            )
    blocked = False
    with pytest.raises(ValidationFailed):
        membership.kits_for_revision(
            owner, target["revision_id"], KitPage(after=first["next_after"])
        )
    restored = membership.kits_for_revision(
        users["viewer"], target["revision_id"], KitPage(limit=2)
    )
    assert restored["results"][1]["revision_id"] == hidden["revision_id"]
    remove_member(users["viewer"])
    with pytest.raises(NotFound):
        membership.kits_for_revision(
            users["viewer"], target["revision_id"], KitPage(after="malformed")
        )
    ensure_member(users["viewer"])
    assert (
        membership.kits_for_revision(users["viewer"], target["revision_id"], KitPage(limit=2))[
            "results"
        ]
        == restored["results"]
    )


def test_membership_uses_latest_kit_at_anchor_before_matching_exact_dependency(users, workspace):
    owner = users["owner"]
    target = frozen(owner, create(owner, workspace))
    other = frozen(owner, create(owner, workspace))
    grouping = create(owner, workspace, "kit", {"kit": kit(target)})
    old = frozen(owner, grouping)
    first = membership.kits_for_revision(users["viewer"], target["revision_id"], KitPage())
    assert [row["revision_id"] for row in first["results"]] == [old["revision_id"]]
    changed = op(
        owner,
        "draft.update",
        {"draft_id": grouping["draft_id"], "changes": {"kit": kit(other)}},
        expected_state=old["draft"]["state"],
    )
    current = frozen(owner, {**grouping, **changed})
    assert (
        membership.kits_for_revision(users["viewer"], target["revision_id"], KitPage())["results"]
        == []
    )
    assert (
        membership.kits_for_revision(users["viewer"], other["revision_id"], KitPage())["results"][
            0
        ]["revision_id"]
        == current["revision_id"]
    )
    # Historical membership stays readable through its exact record, not the current list.
    assert (
        json.loads(bytes(get_revision(users["viewer"], old["revision_id"]).snapshot.canonical))[
            "content"
        ]["kit"]["lines"][0]["revision_id"]
        == target["revision_id"]
    )


def test_many_direct_kit_members_authorize_in_bounded_queries(users, workspace):
    owner = users["owner"]
    parts = [frozen(owner, create(owner, workspace)) for _ in range(20)]
    value = {
        "schema_version": "1",
        "lines": [
            {"local_id": f"part-{i}", "revision_id": row["revision_id"], "quantity": None}
            for i, row in enumerate(parts)
        ],
    }
    with CaptureQueriesContext(connection) as queries:
        created = create(owner, workspace, "kit", {"kit": value})
    assert len(queries) < 30
    assert len(created["content"]["kit"]["lines"]) == 20


def test_library_descriptions_hardware_class_and_grouping_counts_use_exact_selected_state(
    users, workspace
):
    from specmate.workspace.table import list_library_table
    from specmate.workspace.table_contracts import ListLibraryTable

    owner = users["owner"]
    resistor = frozen(owner, create(owner, workspace, content={"part": part()}))
    shell_draft = create(
        owner, workspace, content={"part": part(category="shell", value=None, package=None)}
    )
    shell = frozen(owner, shell_draft)
    # A later saved draft does not relabel the latest frozen catalog row.
    op(
        owner,
        "draft.update",
        {"draft_id": shell_draft["draft_id"], "changes": {"part": part(category="resistor")}},
        expected_state=shell["draft"]["state"],
    )
    grouping = create(owner, workspace, "kit", {"kit": kit(resistor)})
    rows = list_library_table(users["viewer"], ListLibraryTable(catalog_class="parts"))["results"]
    selected = next(row for row in rows if row["latest_revision_id"] == resistor["revision_id"])
    assert {field["key"]: field["value"] for field in selected["summary"]["fields"]} == {
        "category": "resistor",
        "value": "10 kΩ",
        "package": "0603",
        "declared_fits": 0,
    }
    hardware = list_library_table(users["viewer"], ListLibraryTable(catalog_class="hardware"))[
        "results"
    ]
    assert [row["latest_revision_id"] for row in hardware] == [shell["revision_id"]]
    kits = list_library_table(users["viewer"], ListLibraryTable(catalog_class="kits"))["results"]
    assert [row["record_id"] for row in kits] == [grouping["definition_id"]]
    assert kits[0]["summary"]["fields"] == [
        {"key": "part_lines", "label": "Part lines", "value": 1, "unit": None}
    ]


def test_denied_part_closure_withdraws_library_values_and_manufacturer_metadata(
    users, workspace, monkeypatch
):
    from specmate.workspace.table import list_library_table
    from specmate.workspace.table_contracts import ListLibraryTable

    owner = users["owner"]
    target = frozen(owner, create(owner, workspace))
    draft = create(
        owner,
        workspace,
        content={
            "part": part(
                fits=[
                    {
                        "revision_id": target["revision_id"],
                        "basis": "Explicit synthetic declaration",
                    }
                ]
            )
        },
    )
    record = frozen(owner, draft)
    op(
        owner,
        "catalog.register_variant",
        {
            "revision_id": record["revision_id"],
            "manufacturer": "Synthetic maker",
            "part_number": "SYN-R-1",
            "association_basis": "Synthetic association",
        },
    )
    query = ListLibraryTable(query="Synthetic part", catalog_class="parts")
    before = list_library_table(users["viewer"], query)
    assert next(row for row in before["results"] if row["record_id"] == draft["definition_id"])[
        "summary"
    ]["numbers"]
    original = design_operations.authorize_snapshots
    blocked = True

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        if blocked and any(str(row.pk) == target["snapshot_id"] for row in snapshots):
            raise NotFound("Synthetic dependent source closure unavailable.")
        return original(user, snapshots, **kwargs)

    monkeypatch.setattr(design_operations, "authorize_snapshots", guard)
    denied = list_library_table(users["viewer"], query)
    summary = next(row for row in denied["results"] if row["record_id"] == draft["definition_id"])[
        "summary"
    ]
    assert summary["numbers"] == [] and summary["basis"] == "unknown"
    assert all(field["value"] is None for field in summary["fields"])
    assert summary["revision_id"] is None and summary["flags"] == ["Current content unavailable"]
    blocked = False
    assert list_library_table(users["viewer"], query) == before


def test_invalid_kit_api_details_and_dependency_override_rejection(users, workspace):
    owner = users["owner"]
    target = frozen(owner, create(owner, workspace))
    other = frozen(owner, create(owner, workspace))
    response = post_op(
        api(owner),
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "kit",
            "name": "Invalid grouping",
            "content": {"kit": kit(target, quantity={"amount": "0", "unit": "ea"})},
        },
    )
    assert response.status_code == 422
    assert "positive" in response.json()["error"]["details"]["errors"][0]["message"]
    grouping = create(owner, workspace, "kit", {"kit": kit(target)})
    with pytest.raises(ValidationFailed, match="Dependencies must match"):
        freeze(owner, grouping["draft_id"], grouping["state"], [other["revision_id"]])
    assert not Snapshot.objects.filter(definition_id=grouping["definition_id"]).exists()


def test_selected_record_exact_revision_is_independent_of_unavailable_current_draft(
    users, workspace, monkeypatch
):
    from specmate.parts.contracts import RecordSelection
    from specmate.parts.records import selected_record

    owner = users["owner"]
    older_target = frozen(owner, create(owner, workspace))
    later_target = frozen(owner, create(owner, workspace))
    earlier = {
        "part": part(
            fits=[{"revision_id": older_target["revision_id"], "basis": "Earlier explicit target"}]
        )
    }
    draft = create(owner, workspace, content=earlier)
    frozen_part = frozen(owner, draft)
    later = {
        "part": part(
            fits=[{"revision_id": later_target["revision_id"], "basis": "Later explicit target"}]
        )
    }
    saved = op(
        owner,
        "draft.update",
        {"draft_id": draft["draft_id"], "changes": later},
        expected_state=frozen_part["draft"]["state"],
    )
    original = design_operations.authorize_snapshots
    blocked = True

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        if blocked and any(str(row.pk) == later_target["snapshot_id"] for row in snapshots):
            raise NotFound("Current synthetic source unavailable.")
        return original(user, snapshots, **kwargs)

    monkeypatch.setattr(design_operations, "authorize_snapshots", guard)
    result = selected_record(
        users["viewer"], draft["definition_id"], RecordSelection(revision_number=1)
    )
    assert result["selected"]["revision_id"] == frozen_part["revision_id"]
    assert result["selected"]["content"] == earlier
    assert (
        selected_record(users["viewer"], draft["definition_id"], RecordSelection())["selected"]
        == result["selected"]
    )
    with pytest.raises(NotFound):
        selected_record(users["viewer"], draft["definition_id"], RecordSelection(working=True))
    with pytest.raises(NotFound):
        selected_record(
            users["viewer"], draft["definition_id"], RecordSelection(revision_number=999)
        )
    response = api(users["viewer"]).get(
        f"/api/v0/catalog/definitions/{draft['definition_id']}/record?revision_number=1"
    )
    assert response.status_code == 200 and response.json() == result
    blocked = False
    restored = op(
        users["viewer"],
        "catalog.read_record",
        {"definition_id": draft["definition_id"], "draft_id": draft["draft_id"]},
    )
    assert restored["selected"]["state"] == saved["state"]
    assert restored["selected"]["content"] == later
    remove_member(users["viewer"])
    assert (
        api(users["viewer"])
        .get(f"/api/v0/catalog/definitions/{draft['definition_id']}/record?revision_number=999")
        .status_code
        == 404
    )


def test_record_read_requires_explicit_multi_draft_choice_and_can_omit_unneeded_body(
    users, workspace
):
    from specmate.design.models import Draft
    from specmate.parts.contracts import RecordSelection
    from specmate.parts.records import selected_record

    owner = users["owner"]
    legacy = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "part",
            "name": "  Synthetic legacy  ",
            "content": {"note": "  authored note  "},
        },
    )
    legacy_read = selected_record(users["viewer"], legacy["definition_id"], RecordSelection())
    assert legacy_read["name"] == "  Synthetic legacy  "
    assert legacy_read["selected"]["content"]["note"] == "  authored note  "
    created = create(owner, workspace, content={"part": part()})
    other = Draft.objects.create(
        definition_id=created["definition_id"],
        content={"part": part(value="22 kΩ")},
        updated_by=owner,
    )
    with pytest.raises(ValidationFailed, match="explicit working draft"):
        selected_record(users["viewer"], created["definition_id"], RecordSelection(working=True))
    selected = selected_record(
        users["viewer"], created["definition_id"], RecordSelection(draft_id=other.id)
    )
    assert selected["selected"]["draft_id"] == str(other.id)
    assert selected["selected"]["content"]["part"]["value"] == "22 kΩ"
    metadata = selected_record(
        users["viewer"],
        created["definition_id"],
        RecordSelection(draft_id=other.id, include_content=False),
    )
    assert "content" not in metadata["selected"]
    assert metadata["selected"]["draft_id"] == str(other.id)
    assert (
        api(users["outsider"])
        .get(f"/api/v0/catalog/definitions/{created['definition_id']}/record?draft_id={other.id}")
        .status_code
        == 404
    )


def test_selected_reads_reject_deactivated_actor_even_with_stale_principal_object(users, workspace):
    from specmate.parts.contracts import RecordSelection
    from specmate.parts.records import selected_record

    owner = users["owner"]
    created = create(owner, workspace, content={"part": part()})
    revision = frozen(owner, created)
    users["viewer"].__class__.objects.filter(pk=users["viewer"].pk).update(is_active=False)
    assert users["viewer"].is_active
    with pytest.raises(Unauthenticated):
        selected_record(users["viewer"], created["definition_id"], RecordSelection())
    with pytest.raises(Unauthenticated):
        membership.kits_for_revision(users["viewer"], revision["revision_id"], KitPage())
