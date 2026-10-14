"""Original declared facts; expected differences and quantities are independent oracles."""

import copy
import json

import pytest
from django.db import DatabaseError, transaction

from specmate.access.models import WorkspaceMember
from specmate.collaboration.models import ChangeReview, InternalNotification, ReviewEntry
from specmate.design.models import Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord

from .conftest import ensure_member, op
from .test_assemblies import create, freeze, occ
from .test_catalog_matching import source_evidence
from .test_transports import api, post_op


@pytest.fixture
def pair(users, project):
    owner = users["owner"]
    draft = op(
        owner,
        "definition.create",
        {
            "project_id": project,
            "kind": "wire_stock",
            "name": "Original synthetic declared comparison",
            "content": {"length": "12.5", "unknown": None, "typed": True, "removed": "old"},
        },
    )
    old = op(owner, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"])
    updated = op(
        owner,
        "draft.update",
        {
            "draft_id": draft["draft_id"],
            "changes": {"length": "13.75", "unknown": None, "typed": 1, "added": None},
            "remove": ["removed"],
        },
        expected_state=old["draft"]["state"],
    )
    candidate = op(
        owner, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=updated["state"]
    )
    return (
        {"old_revision_id": old["revision_id"], "candidate_revision_id": candidate["revision_id"]},
        old,
        candidate,
    )


def open_review(users, project, pair, **extra):
    return op(
        users["owner"],
        "collaboration.create",
        {
            "project_id": project,
            **pair[0],
            "title": "Original synthetic team change",
            "basis": "Declared values, not physical evidence",
            "recipients": ["editor", "viewer"],
            **extra,
        },
    )


def test_exact_fact_null_absence_type_distinction_and_filtered_parent_pagination(
    users, project, pair
):
    owner, viewer = users["owner"], users["viewer"]
    visible = freeze(owner, create(owner, project, [occ("left", pair[1]), occ("right", pair[1])]))
    secret = op(owner, "project.create", {"name": "Forbidden parent project"})["project_id"]
    hidden = freeze(owner, create(owner, secret, [occ("private", pair[1])]))
    private_draft = op(
        owner,
        "definition.create",
        {"project_id": secret, "kind": "wire_stock", "name": "Forbidden child", "content": {}},
    )
    private_pin = op(
        owner,
        "draft.freeze",
        {"draft_id": private_draft["draft_id"]},
        expected_state=private_draft["state"],
    )
    denied_closure = freeze(
        owner,
        create(owner, project, [occ("public-pin", pair[1]), occ("private-child", private_pin)]),
    )
    value = op(viewer, "collaboration.compare", pair[0])
    assert [(r["path"], r["change"]) for r in value["changes"]] == [
        (["added"], "added"),
        (["length"], "changed"),
        (["removed"], "removed"),
        (["typed"], "changed"),
    ]
    added = value["changes"][0]
    assert (
        added["old_present"] is False
        and added["candidate_present"] is True
        and added["candidate"] is None
    )
    assert value["changes"][-1]["old"] is True and type(value["changes"][-1]["candidate"]) is int
    assert [p["snapshot_id"] for p in value["parents"]["results"]] == [visible["snapshot_id"]]
    assert value["parents"]["next_after"] is None
    assert "Forbidden parent project" not in json.dumps(value) and hidden[
        "snapshot_id"
    ] not in json.dumps(value)
    assert denied_closure["snapshot_id"] not in json.dumps(value)
    with pytest.raises(NotFound):
        op(viewer, "collaboration.compare", {**pair[0], "parents_after": hidden["snapshot_id"]})
    page = op(viewer, "collaboration.compare", {**pair[0], "changes_limit": 2})
    assert page["next_changes_offset"] == 2
    assert (
        op(viewer, "collaboration.compare", {**pair[0], "changes_offset": 2})["changes"]
        == value["changes"][2:]
    )
    assert (
        value["qualification"]
        == value["compatibility"]
        == value["correspondence"]
        == "not_evaluated"
    )


def test_cross_identity_comparison_never_infers_feature_correspondence(users, project, pair):
    second = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "wire_stock",
            "name": "Different identity",
            "content": {"unknown": None},
        },
    )
    other = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": second["draft_id"]},
        expected_state=second["state"],
    )
    comparison = op(
        users["viewer"],
        "collaboration.compare",
        {**pair[0], "candidate_revision_id": other["revision_id"]},
    )
    assert comparison["identity_relation"] == "distinct_definitions"
    assert comparison["correspondence"] == "not_evaluated"


def test_append_history_notifications_recipient_ownership_and_immutable_engineering(
    users, project, pair
):
    before = {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()}
    review = open_review(users, project, pair)
    assert review["state"] == "team-review-v1"
    inbox = op(users["viewer"], "collaboration.inbox", {"project_id": project})
    assert len(inbox["results"]) == 1 and inbox["next_after"] is None
    notification = inbox["results"][0]
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "collaboration.notification",
            {"notification_id": notification["notification_id"]},
        )
    read = op(
        users["viewer"],
        "collaboration.mark_read",
        {"notification_id": notification["notification_id"]},
        expected_state=notification["state"],
        idempotency_key="ack",
    )
    assert read["read_at"] and read["state"] == "notification-read"
    assert (
        op(
            users["viewer"],
            "collaboration.mark_read",
            {"notification_id": notification["notification_id"]},
            expected_state=notification["state"],
            idempotency_key="ack",
        )
        == read
    )
    response = op(
        users["editor"],
        "collaboration.respond",
        {
            "review_id": review["review_id"],
            "action": "recommend",
            "basis": "Declared comparison reviewed; no physical approval",
        },
        expected_state=review["state"],
        idempotency_key="response",
    )
    assert response["entries"][1]["action"] == "recommend"
    assert all(
        response[k] == "not_evaluated"
        for k in ["compatibility", "qualification", "release_approval"]
    )
    assert (
        op(users["owner"], "collaboration.inbox", {"project_id": project})["results"][0]["action"]
        == "recommend"
    )
    assert {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()} == before
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "collaboration.respond",
            {
                "review_id": review["review_id"],
                "action": "comment",
                "basis": "Viewer write forbidden",
            },
            expected_state=response["state"],
        )


def test_cas_conflict_and_close_reopen_without_overwriting_history(users, project, pair):
    review = open_review(users, project, pair)
    payload = {
        "review_id": review["review_id"],
        "action": "close",
        "basis": "Internal team review complete",
    }
    closed = op(
        users["owner"],
        "collaboration.respond",
        payload,
        expected_state=review["state"],
        idempotency_key="close",
    )
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "collaboration.respond",
            {**payload, "action": "comment"},
            expected_state=review["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "collaboration.respond",
            {**payload, "action": "comment"},
            expected_state=closed["state"],
        )
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "collaboration.respond",
            {**payload, "basis": "Different"},
            expected_state=review["state"],
            idempotency_key="close",
        )
    reopened = op(
        users["editor"],
        "collaboration.respond",
        {**payload, "action": "reopen"},
        expected_state=closed["state"],
    )
    assert reopened["status"] == "open" and [e["action"] for e in reopened["entries"]] == [
        "opened",
        "close",
        "reopen",
    ]


def test_source_revocation_hides_inbox_before_key_or_cas_diagnostics(users, project, pair):
    owner = users["owner"]
    review = open_review(users, project, pair)
    source_project = op(owner, "project.create", {"name": "Independent original evidence source"})[
        "project_id"
    ]
    evidence = source_evidence(users, source_project)
    payload = {
        "review_id": review["review_id"],
        "action": "comment",
        "basis": "Exact original source evidence",
        "evidence": evidence,
    }
    reviewed = op(
        owner,
        "collaboration.respond",
        payload,
        expected_state=review["state"],
        idempotency_key="retained-source",
    )
    assert op(users["viewer"], "collaboration.inbox", {"project_id": project})["results"] == []
    WorkspaceMember.objects.filter(workspace__projects=source_project, user=owner).delete()
    with pytest.raises(NotFound):
        op(
            owner,
            "collaboration.respond",
            {**payload, "evidence": {}, "basis": "Omitted old evidence"},
            expected_state=review["state"],
            idempotency_key="retained-source",
        )
    with pytest.raises(NotFound):
        op(owner, "collaboration.respond", {**payload, "evidence": {}}, expected_state="stale")
    assert op(owner, "collaboration.list", {"project_id": project})["results"] == []
    ensure_member(owner, "owner", project=source_project)
    assert (
        op(
            owner,
            "collaboration.respond",
            payload,
            expected_state=review["state"],
            idempotency_key="retained-source",
        )
        == reviewed
    )
    assert ReviewEntry.objects.count() == 2


def test_knowledge_pin_reuses_exact_entry_and_source_owner(users, project, pair):
    owner = users["owner"]
    note = op(
        owner,
        "knowledge.create",
        {
            "project_id": project,
            "kind": "note",
            "content": {"title": "Original comparison basis", "body": "Declared review only"},
        },
    )
    review = open_review(
        users, project, pair, knowledge={"item_id": note["item_id"], "entry_number": 1}
    )
    op(
        owner,
        "knowledge.revise",
        {
            "item_id": note["item_id"],
            "content": {"title": "Later note", "body": "Does not rewrite review"},
        },
        expected_state=note["state"],
    )
    loaded = op(users["viewer"], "collaboration.read", {"review_id": review["review_id"]})
    assert (
        loaded["knowledge"]["number"] == 1
        and loaded["knowledge"]["title"] == "Original comparison basis"
    )


def test_partial_notification_failure_rolls_back_root_entries_and_key(
    users, project, pair, monkeypatch
):
    from specmate.collaboration import queries

    original = queries.notify

    def fail(entry, actor):
        original(entry, actor)
        raise RuntimeError("Original synthetic transaction failure")

    monkeypatch.setattr(queries, "notify", fail)
    with pytest.raises(RuntimeError):
        open_review(users, project, pair)
    assert (
        ChangeReview.objects.count()
        == ReviewEntry.objects.count()
        == InternalNotification.objects.count()
        == 0
    )


def test_database_guards_protect_exact_inputs_sequence_and_pointer(users, project, pair):
    review = open_review(users, project, pair)
    row = ChangeReview.objects.get(id=review["review_id"])
    for mutation in [
        lambda: ChangeReview.objects.filter(id=row.id).update(title="Rewrite"),
        lambda: ReviewEntry.objects.filter(review=row).update(basis="Rewrite"),
        lambda: ReviewEntry.objects.create(
            review=row,
            number=9,
            action="comment",
            basis="Out of sequence",
            author=users["owner"],
            request_id="invalid",
        ),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            mutation()
    notice = InternalNotification.objects.filter(recipient=users["viewer"]).first()
    with pytest.raises(DatabaseError), transaction.atomic():
        InternalNotification.objects.filter(id=notice.id).update(recipient=users["owner"])


def test_registered_http_and_job_authority_transport(users, project, pair):
    review = open_review(users, project, pair)
    client = api(users["viewer"])
    assert (
        post_op(client, "collaboration.read", {"review_id": review["review_id"]}).json()["result"][
            "comparison"
        ]["old"]["revision_id"]
        == pair[0]["old_revision_id"]
    )
    assert (
        post_op(
            client,
            "collaboration.create",
            {"project_id": project, **pair[0], "title": "Not allowed", "basis": "Viewer"},
        ).status_code
        == 403
    )
    assert (
        post_op(
            api(users["outsider"]), "collaboration.read", {"review_id": review["review_id"]}
        ).status_code
        == 404
    )
    old_actor = copy.copy(users["viewer"])
    type(old_actor).objects.filter(id=old_actor.id).update(is_active=False)
    from specmate.collaboration.queries import inspect

    with pytest.raises(Unauthenticated):
        inspect(old_actor, review["review_id"])


def test_registered_http_forbidden_and_missing_reference_errors_are_indistinguishable(
    users, project, pair
):
    review = open_review(users, project, pair)
    outsider = api(users["outsider"])
    missing_id = "00000000-0000-0000-0000-000000000000"
    private = post_op(outsider, "collaboration.read", {"review_id": review["review_id"]})
    missing = post_op(outsider, "collaboration.read", {"review_id": missing_id})
    assert private.status_code == missing.status_code == 404
    assert private.json() == missing.json()
    private_pair = post_op(outsider, "collaboration.compare", pair[0])
    missing_pair = post_op(
        outsider, "collaboration.compare", {**pair[0], "old_revision_id": missing_id}
    )
    assert private_pair.status_code == missing_pair.status_code == 404
    assert private_pair.json() == missing_pair.json()


def test_supported_upgrade_proposal_pins_and_separate_adoption(users, project, pair):
    owner = users["owner"]
    owning = freeze(owner, create(owner, project, [occ("left", pair[1]), occ("right", pair[1])]))
    review = open_review(users, project, pair)
    before = bytes(Snapshot.objects.get(id=owning["snapshot_id"]).canonical)
    result = op(
        owner,
        "collaboration.propose_upgrade",
        {
            "review_id": review["review_id"],
            "owning_snapshot_id": owning["snapshot_id"],
            "paths": [["left"]],
            "basis": "Explicit exact left pin only",
        },
        expected_state=review["state"],
        idempotency_key="proposal",
    )
    proposal = op(
        owner, "upgrade.read", {"proposal_id": result["entries"][-1]["upgrade_proposal_id"]}
    )
    assert (
        proposal["paths"] == [["left"]]
        and proposal["old"]["revision_id"] == pair[0]["old_revision_id"]
    )
    assert (
        proposal["candidate"]["revision_id"] == pair[0]["candidate_revision_id"]
        and proposal["decision"] == "unreviewed"
    )
    assert bytes(Snapshot.objects.get(id=owning["snapshot_id"]).canonical) == before
    assert result["adoption"] == "separate_reviewed_upgrade_operation_required"


@pytest.mark.django_db(transaction=True)
def test_real_concurrent_review_cas_one_entry_and_atomic_notifications(users, project, pair):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connections

    review = open_review(users, project, pair)
    barrier = Barrier(2)

    def submit(role):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            return op(
                users[role],
                "collaboration.respond",
                {
                    "review_id": review["review_id"],
                    "action": "comment",
                    "basis": "Independent " + role,
                },
                expected_state=review["state"],
            )
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(submit, ["owner", "editor"]))
    assert outcomes.count("conflict") == 1
    assert ReviewEntry.objects.filter(review_id=review["review_id"]).count() == 2
    assert ChangeReview.objects.get(id=review["review_id"]).version == 2
    assert len({str(n.entry_id) for n in InternalNotification.objects.all()}) == 2


@pytest.mark.django_db(transaction=True)
def test_final_source_reauthorization_rolls_back_after_real_external_revocation(
    users, project, pair, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections, connections

    from specmate.collaboration import queries

    owner = users["owner"]
    review = open_review(users, project, pair)
    source_project = op(owner, "project.create", {"name": "Original independent authority source"})[
        "project_id"
    ]
    evidence = source_evidence(users, source_project)
    original = queries.notify

    def revoke():
        close_old_connections()
        try:
            WorkspaceMember.objects.filter(workspace__projects=source_project, user=owner).delete()
        finally:
            connections.close_all()

    def after_insert(entry, actor):
        original(entry, actor)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(revoke).result(timeout=15)

    monkeypatch.setattr(queries, "notify", after_insert)
    payload = {
        "review_id": review["review_id"],
        "action": "comment",
        "basis": "Exact source receipt",
        "evidence": evidence,
    }
    with pytest.raises(NotFound):
        op(
            owner,
            "collaboration.respond",
            payload,
            expected_state=review["state"],
            idempotency_key="final-closure",
        )
    assert ReviewEntry.objects.filter(review_id=review["review_id"]).count() == 1
    assert ChangeReview.objects.get(id=review["review_id"]).version == 1
    assert not IdempotencyRecord.objects.filter(
        operation="collaboration.respond", key="final-closure"
    ).exists()
    ensure_member(owner, "owner", project=source_project)
    monkeypatch.setattr(queries, "notify", original)
    recovered = op(
        owner,
        "collaboration.respond",
        payload,
        expected_state=review["state"],
        idempotency_key="final-closure",
    )
    assert recovered["state"] == "team-review-v2"


@pytest.mark.django_db(transaction=True)
def test_final_history_serialization_revocation_rolls_back_response_and_exact_retry(
    users, project, pair, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections, connections

    from specmate.collaboration import queries

    owner = users["owner"]
    review = open_review(users, project, pair)
    source_project = op(owner, "project.create", {"name": "Independent review history source"})[
        "project_id"
    ]
    evidence = source_evidence(users, source_project)
    before_notices = set(InternalNotification.objects.values_list("id", flat=True))
    original = queries.evidence_result

    def revoke():
        close_old_connections()
        try:
            WorkspaceMember.objects.filter(workspace__projects=source_project, user=owner).delete()
        finally:
            connections.close_all()

    def serialize_then_revoke(entry):
        result = original(entry)
        if entry.source_file_id:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(revoke).result(timeout=15)
        return result

    monkeypatch.setattr(queries, "evidence_result", serialize_then_revoke)
    payload = {
        "review_id": review["review_id"],
        "action": "comment",
        "basis": "Exact retained source evidence",
        "evidence": evidence,
    }
    with pytest.raises(NotFound):
        op(
            owner,
            "collaboration.respond",
            payload,
            expected_state=review["state"],
            idempotency_key="serialized-history",
        )
    assert not WorkspaceMember.objects.filter(
        workspace__projects=source_project, user=owner
    ).exists()
    assert ReviewEntry.objects.filter(review_id=review["review_id"]).count() == 1
    assert ChangeReview.objects.get(id=review["review_id"]).version == 1
    assert set(InternalNotification.objects.values_list("id", flat=True)) == before_notices
    assert not IdempotencyRecord.objects.filter(
        operation="collaboration.respond", key="serialized-history"
    ).exists()
    ensure_member(owner, "owner", project=source_project)
    monkeypatch.setattr(queries, "evidence_result", original)
    recovered = op(
        owner,
        "collaboration.respond",
        payload,
        expected_state=review["state"],
        idempotency_key="serialized-history",
    )
    assert recovered["state"] == "team-review-v2"
    assert recovered["entries"][-1]["evidence"]["source_path"] == evidence["source_path"]


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", ["collaboration.list", "collaboration.inbox"])
def test_serialization_revocation_omits_protected_review_and_notification_pages(
    users, project, pair, monkeypatch, operation
):
    from concurrent.futures import ThreadPoolExecutor

    from django.db import close_old_connections, connections

    from specmate.collaboration import queries

    owner, recipient = users["owner"], users["editor"]
    review = open_review(users, project, pair)
    source_project = op(owner, "project.create", {"name": "Independent inbox evidence source"})[
        "project_id"
    ]
    evidence = source_evidence(users, source_project)
    ensure_member(recipient, "viewer", project=source_project)
    op(
        owner,
        "collaboration.respond",
        {
            "review_id": review["review_id"],
            "action": "comment",
            "basis": "Protected evidence history",
            "evidence": evidence,
        },
        expected_state=review["state"],
    )
    original = queries.evidence_result
    revoked = False

    def revoke():
        close_old_connections()
        try:
            WorkspaceMember.objects.filter(
                workspace__projects=source_project, user=recipient
            ).delete()
        finally:
            connections.close_all()

    def serialize_then_revoke(entry):
        nonlocal revoked
        result = original(entry)
        if entry.source_file_id and not revoked:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(revoke).result(timeout=15)
            revoked = True
        return result

    monkeypatch.setattr(queries, "evidence_result", serialize_then_revoke)
    page = op(recipient, operation, {"project_id": project})
    assert revoked and page == {"results": [], "next_after": None}
    assert not WorkspaceMember.objects.filter(
        workspace__projects=source_project, user=recipient
    ).exists()
    ensure_member(recipient, "viewer", project=source_project)
    recovered = op(recipient, operation, {"project_id": project})
    assert recovered["results"] and all(
        row["review_id"] == review["review_id"] for row in recovered["results"]
    )


def test_changed_review_id_cannot_bypass_denied_stored_receipt_closure(users, project, pair):
    owner = users["owner"]
    historical = open_review(users, project, pair)
    independent = open_review(users, project, pair, title="Separate authorized review")
    source_project = op(owner, "project.create", {"name": "Exact stored response source"})[
        "project_id"
    ]
    evidence = source_evidence(users, source_project)
    payload = {
        "review_id": historical["review_id"],
        "action": "comment",
        "basis": "Stored exact evidence",
        "evidence": evidence,
    }
    receipt = op(
        owner,
        "collaboration.respond",
        payload,
        expected_state=historical["state"],
        idempotency_key="different-review-input",
    )
    WorkspaceMember.objects.filter(workspace__projects=source_project, user=owner).delete()
    changed = {"review_id": independent["review_id"], "action": "comment", "basis": "New inputs"}
    assert op(owner, "collaboration.read", {"review_id": independent["review_id"]})
    with pytest.raises(NotFound):
        op(
            owner,
            "collaboration.respond",
            changed,
            expected_state=independent["state"],
            idempotency_key="different-review-input",
        )
    ensure_member(owner, "owner", project=source_project)
    with pytest.raises(IdempotencyMismatch):
        op(
            owner,
            "collaboration.respond",
            changed,
            expected_state=independent["state"],
            idempotency_key="different-review-input",
        )
    assert (
        op(
            owner,
            "collaboration.respond",
            payload,
            expected_state=historical["state"],
            idempotency_key="different-review-input",
        )
        == receipt
    )
    assert ReviewEntry.objects.filter(review_id=independent["review_id"]).count() == 1


def test_mounted_review_and_inbox_queries_keep_private_bytes_uncached(users, project, pair):
    review = open_review(users, project, pair)
    viewer = api(users["viewer"])
    paths = [
        f"/api/v0/collaboration/reviews/{review['review_id']}",
        f"/api/v0/collaboration/projects/{project}/reviews",
        f"/api/v0/collaboration/projects/{project}/inbox",
    ]
    for path in paths:
        response = viewer.get(path)
        assert response.status_code == 200
        assert response["Cache-Control"] == "private, no-store"
    assert viewer.get(paths[0]).json()["review_id"] == review["review_id"]
    assert viewer.get(paths[1]).json()["results"][0]["review_id"] == review["review_id"]
    notices = viewer.get(paths[2]).json()["results"]
    assert len(notices) == 1 and notices[0]["review_id"] == review["review_id"]
    notice_path = f"/api/v0/collaboration/notifications/{notices[0]['notification_id']}"
    response = viewer.get(notice_path)
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    # Even the project's owner cannot inspect another recipient's notification.
    owner = api(users["owner"])
    missing = "/api/v0/collaboration/notifications/00000000-0000-0000-0000-000000000000"
    denied = owner.get(notice_path)
    absent = owner.get(missing)
    assert denied.status_code == absent.status_code == 404
    assert denied.json() == absent.json()
    outsider = api(users["outsider"])
    denied = outsider.get(paths[0])
    absent = outsider.get("/api/v0/collaboration/reviews/00000000-0000-0000-0000-000000000000")
    assert denied.status_code == absent.status_code == 404
    assert denied.json() == absent.json()
