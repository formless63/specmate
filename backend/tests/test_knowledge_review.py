"""Independent knowledge current authority, origin isolation and competing links."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connections

from specmate.access.models import WorkspaceMember
from specmate.facts.contracts import ProjectTarget
from specmate.knowledge.models import KnowledgeEntry, KnowledgeItem, KnowledgeLink
from specmate.knowledge.queries import items_for_target, project_items, read_item
from specmate.operations import NotFound, Unauthenticated

from .conftest import ensure_member, op
from .test_knowledge import create
from .test_physical_units import unit_payload
from .test_shared_read_authority import adopted_assembly, restore, revoke  # noqa: F401
from .test_transports import api, post_op


@pytest.mark.parametrize("reader", ["item", "project", "target"])
def test_captured_inactive_plain_note_actor_is_rejected_before_disclosure(users, project, reader):
    note = create(
        users["owner"],
        project,
        kind="note",
        title="Independent plain note",
        body="Synthetic own note.",
        links=[{"kind": "project", "project_id": project}],
    )
    actor = users["viewer"]
    client = api(actor)
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    assert actor.is_active
    target = ProjectTarget(kind="project", project_id=project)
    reads = {
        "item": lambda: read_item(actor, note["item_id"]),
        "project": lambda: project_items(actor, project),
        "target": lambda: items_for_target(actor, target),
    }
    with pytest.raises(Unauthenticated):
        reads[reader]()
    with pytest.raises(Unauthenticated):
        op(actor, "knowledge.read", {"item_id": note["item_id"]})
    assert client.get("/api/v0/knowledge/items/" + note["item_id"]).status_code == 401
    assert post_op(client, "knowledge.list", {"project_id": project}).status_code == 401
    get_user_model().objects.filter(pk=actor.pk).update(is_active=True)
    assert read_item(actor, note["item_id"])["current"]["body"] == "Synthetic own note."


@pytest.mark.parametrize("kind", ["definition", "revision", "occurrence", "physical_unit"])
def test_retained_target_origin_hides_links_but_preserves_owned_note_and_history(
    users,
    project,
    adopted_assembly,  # noqa: F811
    kind,
):
    remote, adopted, frozen = adopted_assembly
    if kind == "definition":
        target = {"kind": kind, "definition_id": str(adopted.definition_id)}
    elif kind == "revision":
        target = {"kind": kind, "revision_id": frozen["revision_id"]}
    elif kind == "occurrence":
        target = {"kind": kind, "snapshot_id": frozen["snapshot_id"], "path": ["child"]}
    else:
        unit = op(
            users["owner"],
            "physical_units.register",
            unit_payload(frozen["revision_id"], "SYNTH-KNW-ORIGIN"),
            idempotency_key="own-unit",
        )
        target = {"kind": kind, "unit_id": unit["unit_id"]}
    note = create(
        users["owner"],
        project,
        kind="note",
        title="Own note retained",
        body="Synthetic declaration; no physical measurement.",
        links=[target],
    )
    before = read_item(users["viewer"], note["item_id"])
    assert len(before["links"]) == 1
    revoke(users, remote)
    hidden = read_item(users["viewer"], note["item_id"])
    assert hidden["current"] == before["current"] and hidden["history"] == before["history"]
    assert hidden["links"] == hidden["removed_links"] == []
    assert "link_count" not in hidden
    text = json.dumps(hidden)
    for secret in [
        remote,
        str(adopted.definition_id),
        frozen["revision_id"],
        frozen["snapshot_id"],
    ]:
        assert secret not in text
    with pytest.raises(NotFound):
        op(users["viewer"], "knowledge.for_target", {"target": target})
    restore(users, remote)
    assert read_item(users["viewer"], note["item_id"]) == before


@pytest.mark.django_db(transaction=True)
def test_competing_exact_target_links_keep_one_active_identity(users, project):
    note = create(
        users["owner"],
        project,
        kind="note",
        title="Competing link fixture",
        body="Synthetic own note.",
    )
    target = {"kind": "project", "project_id": project}
    barrier = Barrier(2)

    def write(index):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            return op(
                users["editor"],
                "knowledge.link",
                {"item_id": note["item_id"], "target": target},
                idempotency_key=f"competing-link-{index}",
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        answers = list(pool.map(write, [1, 2]))
    assert sorted(answer["created"] for answer in answers) == [False, True]
    assert len({answer["link_id"] for answer in answers}) == 1
    assert (
        KnowledgeLink.objects.filter(item_id=note["item_id"], removed_at__isnull=True).count() == 1
    )
    assert KnowledgeItem.objects.count() == KnowledgeEntry.objects.count() == 1


def test_invalid_later_link_rolls_back_complete_item_and_entry(users, project):
    remote = op(users["owner"], "project.create", {"name": "Unreadable valid note target"})[
        "project_id"
    ]
    before = (
        KnowledgeItem.objects.count(),
        KnowledgeEntry.objects.count(),
        KnowledgeLink.objects.count(),
    )
    with pytest.raises(NotFound):
        create(
            users["editor"],
            project,
            kind="note",
            body="Synthetic.",
            links=[
                {"kind": "project", "project_id": project},
                {"kind": "project", "project_id": remote},
            ],
            key="rollback-item",
        )
    assert (
        KnowledgeItem.objects.count(),
        KnowledgeEntry.objects.count(),
        KnowledgeLink.objects.count(),
    ) == before


@pytest.mark.parametrize("receipt_kind", ["create", "revise", "removed"])
def test_receipt_replay_cannot_restore_a_now_hidden_foreign_link(users, project, receipt_kind):
    remote = op(users["owner"], "project.create", {"name": "Independent foreign target"})[
        "project_id"
    ]
    ensure_member(users["editor"], "viewer", project=remote)
    create_payload = {
        "project_id": project,
        "kind": "note",
        "content": {"title": "Own note", "body": "Synthetic own note."},
        "links": [{"kind": "project", "project_id": remote}],
    }
    note = op(users["editor"], "knowledge.create", create_payload, idempotency_key="initial-item")
    if receipt_kind == "create":
        receipt = note
        operation, payload, context = (
            "knowledge.create",
            create_payload,
            {"idempotency_key": "initial-item"},
        )
    else:
        if receipt_kind == "removed":
            op(
                users["editor"],
                "knowledge.unlink",
                {"link_id": note["links"][0]["link_id"], "reason": "Synthetic deliberate removal."},
            )
        payload = {
            "item_id": note["item_id"],
            "content": {"title": "Own revision", "body": "Synthetic own revision."},
        }
        operation, context = (
            "knowledge.revise",
            {"expected_state": note["state"], "idempotency_key": "exact-revision-receipt"},
        )
        receipt = op(users["editor"], operation, payload, **context)
    rows = receipt["removed_links"] if receipt_kind == "removed" else receipt["links"]
    assert rows[0]["project_id"] == remote
    WorkspaceMember.objects.filter(workspace__projects=remote, user=users["editor"]).delete()
    current = read_item(users["editor"], note["item_id"])
    assert (
        current["current"] == receipt["current"]
        and current["links"] == current["removed_links"] == []
    )
    assert api(users["editor"]).get("/api/v0/knowledge/items/" + note["item_id"]).json() == current
    # Editing the owned note stays available; replay cannot return old target metadata.
    fresh = op(
        users["editor"],
        "knowledge.revise",
        {
            "item_id": note["item_id"],
            "content": {"title": "Own later entry", "body": "Still an owned synthetic note."},
        },
        expected_state=current["state"],
    )
    assert fresh["links"] == fresh["removed_links"] == []
    assert fresh["history"][:-1] == current["history"]
    count = KnowledgeEntry.objects.filter(item_id=note["item_id"]).count()
    with pytest.raises(NotFound):
        op(users["editor"], operation, payload, **context)
    denied = post_op(api(users["editor"]), operation, payload, **context)
    assert denied.status_code == 404 and remote.encode() not in denied.content
    assert KnowledgeEntry.objects.filter(item_id=note["item_id"]).count() == count
    ensure_member(users["editor"], "viewer", project=remote)
    assert op(users["editor"], operation, payload, **context) == receipt
    assert post_op(api(users["editor"]), operation, payload, **context).json()["result"] == receipt
    assert KnowledgeEntry.objects.filter(item_id=note["item_id"]).count() == count
