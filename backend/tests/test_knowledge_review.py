"""Independent knowledge current authority, origin isolation and competing links."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connections

from specmate.facts.contracts import ProjectTarget
from specmate.knowledge.models import KnowledgeEntry, KnowledgeItem, KnowledgeLink
from specmate.knowledge.queries import items_for_target, list_workspace_items, read_item
from specmate.operations import NotFound, Unauthenticated

from .conftest import member, op, remove_member
from .test_knowledge import create, world  # noqa: F401
from .test_transports import api, post_op


@pytest.mark.parametrize("reader", ["item", "project", "target"])
def test_captured_inactive_plain_note_actor_is_rejected_before_disclosure(
    users, project, workspace, reader
):
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
        "project": lambda: list_workspace_items(actor, workspace, project),
        "target": lambda: items_for_target(actor, target),
    }
    with pytest.raises(Unauthenticated):
        reads[reader]()
    with pytest.raises(Unauthenticated):
        op(actor, "knowledge.read", {"item_id": note["item_id"]})
    assert client.get("/api/v0/knowledge/items/" + note["item_id"]).status_code == 401
    assert post_op(client, "knowledge.list", {"workspace_id": workspace}).status_code == 401
    get_user_model().objects.filter(pk=actor.pk).update(is_active=True)
    assert read_item(actor, note["item_id"])["current"]["body"] == "Synthetic own note."


@pytest.mark.parametrize(
    "kind,key",
    [
        ("definition", "definition"),
        ("revision", "r1"),
        ("occurrence", "left"),
        ("physical_unit", "unit1"),
    ],
)
def test_membership_removal_hides_the_note_and_restoration_returns_identical_history(
    users,
    project,
    world,  # noqa: F811
    kind,
    key,
):
    target = world["targets"][key]
    assert target["kind"] == kind
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
    remove_member(users["viewer"])
    for read in (
        lambda: read_item(users["viewer"], note["item_id"]),
        lambda: op(users["viewer"], "knowledge.for_target", {"target": target}),
        lambda: op(users["viewer"], "knowledge.read", {"item_id": note["item_id"]}),
    ):
        with pytest.raises(NotFound) as exc:
            read()
        assert exc.value.details == {}
    response = api(users["viewer"]).get("/api/v0/knowledge/items/" + note["item_id"])
    assert response.status_code == 404 and note["item_id"] not in json.dumps(response.json())
    # The note and its history are untouched by the loss of one reader.
    assert KnowledgeEntry.objects.filter(item_id=note["item_id"]).count() == 1
    member(users["viewer"], "viewer")
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
    remote = op(users["outsider"], "project.create", {"name": "Foreign workspace target"})[
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
def test_receipt_replay_requires_current_membership(users, project, workspace, receipt_kind):
    create_payload = {
        "workspace_id": workspace,
        "project_id": project,
        "kind": "note",
        "content": {"title": "Own note", "body": "Synthetic own note."},
        "links": [{"kind": "project", "project_id": project}],
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
    assert rows[0]["target"]["project_id"] == project
    count = KnowledgeEntry.objects.filter(item_id=note["item_id"]).count()
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        read_item(users["editor"], note["item_id"])
    assert api(users["editor"]).get("/api/v0/knowledge/items/" + note["item_id"]).status_code == 404
    with pytest.raises(NotFound):
        op(users["editor"], operation, payload, **context)
    denied = post_op(api(users["editor"]), operation, payload, **context)
    assert denied.status_code == 404 and project.encode() not in denied.content
    assert KnowledgeEntry.objects.filter(item_id=note["item_id"]).count() == count
    member(users["editor"], "editor")
    assert op(users["editor"], operation, payload, **context) == receipt
    assert post_op(api(users["editor"]), operation, payload, **context).json()["result"] == receipt
    assert KnowledgeEntry.objects.filter(item_id=note["item_id"]).count() == count
