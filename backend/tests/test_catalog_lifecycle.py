"""Catalog corrections preserve identities, frozen bytes and explicit consumer pins."""

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.catalog.models import DefinitionLifecycle
from specmate.catalog.queries import get_identity, list_definitions
from specmate.design.models import Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.queries import get_revision

from .conftest import member, op, remove_member
from .test_transports import api, post_op


def item(user, workspace, kind="part"):
    draft = op(
        user,
        "definition.create",
        {"workspace_id": workspace, "kind": kind, "name": "Synthetic replacement"},
    )
    frozen = op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    return draft, frozen


def lifecycle(user, definition, replacement=None, status="superseded", state="lifecycle-v0", **ctx):
    return op(
        user,
        "catalog.set_lifecycle",
        {
            "definition_id": definition["definition_id"],
            "status": status,
            "replacement_revision_id": replacement["revision_id"] if replacement else None,
            "basis": "Reviewed synthetic catalog correction",
        },
        expected_state=state,
        **ctx,
    )


def test_supersession_keeps_frozen_history_and_explicit_replacement(users, workspace):
    old, old_rev = item(users["owner"], workspace, "part")
    _new, new_rev = item(users["owner"], workspace, "board")
    before = bytes(Snapshot.objects.get(id=old_rev["snapshot_id"]).canonical)
    first = lifecycle(users["editor"], old, new_rev, idempotency_key="replace-one")
    assert first["replacement_revision_id"] == new_rev["revision_id"]
    assert lifecycle(users["editor"], old, new_rev, idempotency_key="replace-one") == first
    assert get_identity(users["viewer"], old["definition_id"])["lifecycle"] == first
    assert get_revision(users["viewer"], old_rev["revision_id"])
    client = api(users["viewer"])
    ordinary = client.get("/api/v0/workspace/library").json()["results"]
    assert old["definition_id"] not in {row["record_id"] for row in ordinary}
    retained = client.get("/api/v0/workspace/library?include_superseded=true").json()["results"]
    assert (
        next(row for row in retained if row["record_id"] == old["definition_id"])["detail"]
        == "Catalog status: superseded"
    )
    assert client.get(f"/api/v0/workspace/library/{old['definition_id']}").status_code == 200
    assert old["definition_id"] not in {
        r["definition_id"]
        for r in list_definitions(users["viewer"], workspace_id=workspace)["results"]
    }
    assert old["definition_id"] in {
        r["definition_id"]
        for r in list_definitions(users["viewer"], workspace_id=workspace, include_superseded=True)[
            "results"
        ]
    }
    assert bytes(Snapshot.objects.get(id=old_rev["snapshot_id"]).canonical) == before
    with pytest.raises(Conflict):
        lifecycle(users["editor"], old, status="active")
    with pytest.raises(IdempotencyMismatch):
        lifecycle(users["editor"], old, status="active", idempotency_key="replace-one")
    active = lifecycle(users["editor"], old, status="active", state="lifecycle-v1")
    assert active["state"] == "lifecycle-v2" and active["replacement_revision_id"] is None
    assert DefinitionLifecycle.objects.filter(definition_id=old["definition_id"]).count() == 2


def test_cycle_self_scope_and_invalid_lifecycle_refused(users, workspace, other_workspace):
    a, ar = item(users["owner"], workspace)
    b, br = item(users["owner"], workspace)
    lifecycle(users["owner"], a, br)
    for source, target in [(b, ar), (b, br)]:
        with pytest.raises(ValidationFailed):
            lifecycle(users["owner"], source, target)
    _, foreign = item(users["outsider"], other_workspace)
    member(users["owner"], "editor", workspace=other_workspace)
    with pytest.raises(NotFound):
        lifecycle(users["owner"], b, foreign)
    with pytest.raises(ValidationFailed):
        lifecycle(users["owner"], b, status="superseded")
    with pytest.raises(ValidationFailed):
        lifecycle(users["owner"], b, br, status="active")
    assert DefinitionLifecycle.objects.count() == 1


def test_current_authority_api_and_replay(users, workspace):
    a, _ = item(users["owner"], workspace)
    _b, br = item(users["owner"], workspace)
    for role, exc in [("viewer", PermissionDenied), ("outsider", NotFound)]:
        with pytest.raises(exc):
            lifecycle(users[role], a, br)
    payload = {
        "definition_id": a["definition_id"],
        "status": "superseded",
        "replacement_revision_id": br["revision_id"],
        "basis": "Reviewed correction",
    }
    response = post_op(
        api(users["editor"]),
        "catalog.set_lifecycle",
        payload,
        expected_state="lifecycle-v0",
        idempotency_key="api-life",
    )
    assert response.status_code == 200
    remove_member(users["editor"], workspace=workspace)
    response = post_op(
        api(users["editor"]),
        "catalog.set_lifecycle",
        payload,
        expected_state="lifecycle-v0",
        idempotency_key="api-life",
    )
    assert response.status_code == 404


def test_database_guards_immutable_scope_sequence_and_cycles(users, workspace, other_workspace):
    a, ar = item(users["owner"], workspace)
    b, br = item(users["owner"], workspace)
    lifecycle(users["owner"], a, br)
    _, foreign = item(users["outsider"], other_workspace)
    for source, target, sequence in [(b, ar, 1), (b, br, 1), (b, foreign, 1), (b, ar, 5)]:
        with pytest.raises(DatabaseError), transaction.atomic():
            DefinitionLifecycle.objects.create(
                definition_id=source["definition_id"],
                sequence=sequence,
                status="superseded",
                replacement_id=target["revision_id"],
                basis="Invalid direct write",
                registered_by=users["owner"],
            )
    for sql in [
        "UPDATE catalog_definitionlifecycle SET basis='changed'",
        "DELETE FROM catalog_definitionlifecycle",
    ]:
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql)


@pytest.mark.django_db(transaction=True)
def test_competing_replacements_one_cas_winner(users, workspace):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections

    a, _ = item(users["owner"], workspace)
    _, br = item(users["owner"], workspace)
    gate = Barrier(2)

    def competing(_):
        close_old_connections()
        try:
            gate.wait(timeout=10)
            try:
                lifecycle(users["owner"], a, br)
                return "created"
            except Conflict:
                return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(competing, range(2))) == ["conflict", "created"]


def test_replacement_can_atomically_guard_reviewed_source_draft(users, workspace):
    old, old_revision = item(users["owner"], workspace)
    _new, replacement = item(users["owner"], workspace, "board")
    guarded = {
        "definition_id": old["definition_id"],
        "status": "superseded",
        "replacement_revision_id": replacement["revision_id"],
        "basis": "Reviewed source draft",
        "reviewed_draft": {"draft_id": old["draft_id"], "state": old_revision["draft"]["state"]},
    }
    updated = op(
        users["owner"],
        "draft.update",
        {"draft_id": old["draft_id"], "changes": {"user_note": "Keep my work"}},
        expected_state=old_revision["draft"]["state"],
    )
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "catalog.set_lifecycle",
            guarded,
            expected_state="lifecycle-v0",
            idempotency_key="reviewed-source",
        )
    assert not DefinitionLifecycle.objects.exists()
    guarded["reviewed_draft"]["state"] = updated["state"]
    first = op(
        users["owner"],
        "catalog.set_lifecycle",
        guarded,
        expected_state="lifecycle-v0",
        idempotency_key="reviewed-source",
    )
    op(
        users["owner"],
        "draft.update",
        {"draft_id": old["draft_id"], "changes": {"later_note": "Retained too"}},
        expected_state=updated["state"],
    )
    assert (
        op(
            users["owner"],
            "catalog.set_lifecycle",
            guarded,
            expected_state="lifecycle-v0",
            idempotency_key="reviewed-source",
        )
        == first
    )
    from specmate.queries import get_draft

    assert get_draft(users["owner"], old["draft_id"])["content"]["user_note"] == "Keep my work"


def test_reviewed_draft_must_belong_to_source_definition(users, workspace):
    old, _old_revision = item(users["owner"], workspace)
    other, replacement = item(users["owner"], workspace)
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "catalog.set_lifecycle",
            {
                "definition_id": old["definition_id"],
                "status": "superseded",
                "replacement_revision_id": replacement["revision_id"],
                "basis": "Wrong draft scope",
                "reviewed_draft": {"draft_id": other["draft_id"], "state": "draft-v2"},
            },
            expected_state="lifecycle-v0",
        )
    assert not DefinitionLifecycle.objects.exists()
