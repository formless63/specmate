import json

import pytest
from django.db import connection, transaction
from django.db.utils import DatabaseError

from specmate.access.models import Membership
from specmate.design.models import Revision, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op


def freeze(user, draft_id, state, deps=()):
    return op(
        user,
        "draft.freeze",
        {"draft_id": draft_id, "dependencies": list(deps)},
        expected_state=state,
    )


def test_draft_saves_incomplete_content_and_advances_state(users, definition):
    assert definition["state"] == "draft-v1"
    updated = op(
        users["editor"],
        "draft.update",
        {"draft_id": definition["draft_id"], "changes": {"b": None}, "remove": ["a"]},
        expected_state="draft-v1",
    )
    assert updated["state"] == "draft-v2"
    assert updated["content"] == {"b": None}


def test_stale_edit_conflicts_with_current_state(users, definition):
    draft = definition["draft_id"]
    op(
        users["owner"],
        "draft.update",
        {"draft_id": draft, "changes": {"x": 1}},
        expected_state="draft-v1",
    )
    with pytest.raises(Conflict) as exc:
        op(
            users["editor"],
            "draft.update",
            {"draft_id": draft, "changes": {"x": 2}},
            expected_state="draft-v1",
        )
    assert exc.value.details["current"]["state"] == "draft-v2"
    assert exc.value.details["current"]["content"]["x"] == 1


def test_mutation_requires_expected_state(users, definition):
    with pytest.raises(ValidationFailed):
        op(users["owner"], "draft.update", {"draft_id": definition["draft_id"], "changes": {}})


def test_frozen_revision_and_pins_survive_later_edits_byte_for_byte(users, project, definition):
    dep_def = op(
        users["owner"],
        "definition.create",
        {"project_id": project, "kind": "part", "name": "Dependency"},
    )
    dep = freeze(users["owner"], dep_def["draft_id"], dep_def["state"])
    frozen = freeze(users["owner"], definition["draft_id"], "draft-v1", [dep["revision_id"]])
    assert frozen["number"] == 1
    before = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)

    op(
        users["owner"],
        "draft.update",
        {"draft_id": definition["draft_id"], "changes": {"a": 2}},
        expected_state=frozen["draft"]["state"],
    )

    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    assert bytes(snapshot.canonical) == before
    body = json.loads(before)
    assert body["content"] == {"a": 1}
    assert body["dependencies"] == [{"revision_id": dep["revision_id"], "sha256": dep["sha256"]}]
    assert [d.revision_id for d in snapshot.dependencies.all()] == [
        Revision.objects.get(id=dep["revision_id"]).id
    ]


def test_second_freeze_gets_next_number(users, definition):
    first = freeze(users["owner"], definition["draft_id"], "draft-v1")
    second = freeze(users["owner"], definition["draft_id"], first["draft"]["state"])
    assert (first["number"], second["number"]) == (1, 2)
    assert first["sha256"] != "" and first["snapshot_id"] != second["snapshot_id"]


@pytest.mark.parametrize("table", ["design_snapshot", "design_revision"])
def test_database_rejects_update_and_delete_of_frozen_rows(users, definition, table):
    freeze(users["owner"], definition["draft_id"], "draft-v1")
    for statement in (f"UPDATE {table} SET id = id", f"DELETE FROM {table}"):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cur:
            cur.execute(statement)


def test_freeze_is_separate_authority_from_editing(users, project, definition):
    with pytest.raises(PermissionDenied):
        freeze(users["editor"], definition["draft_id"], "draft-v1")
    Membership.objects.filter(project_id=project, user=users["editor"]).update(
        grants=["design.freeze"]
    )
    assert freeze(users["editor"], definition["draft_id"], "draft-v1")["number"] == 1


def test_viewer_cannot_edit(users, definition):
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "draft.update",
            {"draft_id": definition["draft_id"], "changes": {"a": 3}},
            expected_state="draft-v1",
        )


def test_outsider_sees_not_found_not_denied(users, project, definition):
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "draft.update",
            {"draft_id": definition["draft_id"], "changes": {}},
            expected_state="draft-v1",
        )
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "definition.create",
            {"project_id": project, "kind": "part", "name": "x"},
        )


def test_cannot_pin_a_revision_from_an_unreadable_project(users, definition):
    other = op(users["outsider"], "project.create", {"name": "Elsewhere"})
    hidden = op(
        users["outsider"],
        "definition.create",
        {"project_id": other["project_id"], "kind": "part", "name": "Hidden"},
    )
    hidden_rev = freeze(users["outsider"], hidden["draft_id"], hidden["state"])
    with pytest.raises(NotFound):
        freeze(users["owner"], definition["draft_id"], "draft-v1", [hidden_rev["revision_id"]])


def test_snapshot_without_revision_for_builds(users, definition):
    result = op(
        users["editor"],
        "draft.snapshot",
        {"draft_id": definition["draft_id"]},
        expected_state="draft-v1",
    )
    snapshot = Snapshot.objects.get(id=result["snapshot_id"])
    assert not Revision.objects.filter(snapshot=snapshot).exists()


def test_idempotent_replay_and_mismatch(users, definition):
    payload = {"draft_id": definition["draft_id"], "changes": {"k": 1}}
    first = op(
        users["editor"],
        "draft.update",
        payload,
        expected_state="draft-v1",
        idempotency_key="edit-1",
    )
    replay = op(
        users["editor"],
        "draft.update",
        payload,
        expected_state="draft-v1",
        idempotency_key="edit-1",
    )
    assert replay == first and first["state"] == "draft-v2"
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "draft.update",
            {**payload, "changes": {"k": 2}},
            expected_state="draft-v1",
            idempotency_key="edit-1",
        )


def test_failed_operation_leaves_no_partial_state(users, definition):
    before = Snapshot.objects.count()
    with pytest.raises(NotFound):
        freeze(
            users["owner"],
            definition["draft_id"],
            "draft-v1",
            ["00000000-0000-0000-0000-000000000000"],
        )
    assert Snapshot.objects.count() == before
