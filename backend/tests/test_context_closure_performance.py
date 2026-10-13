"""Bound repeated closure work without retaining authority between operations."""

import json
from uuid import UUID

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.test.utils import CaptureQueriesContext

from specmate.assemblies.queries import read_assembly
from specmate.bom.queries import inspect_revision
from specmate.design.models import Snapshot
from specmate.design.operations import authorize_snapshot
from specmate.operations import Conflict, NotFound, Unauthenticated, ValidationFailed

from .conftest import op
from .test_bom import assembly, capture, create, part, policy
from .test_shared_read_authority import adopt_with_remote_origin, restore, revoke
from .test_transports import api, post_op


def test_direct_bom_reader_rejects_captured_inactive_actor(users, project):
    root = assembly(users["owner"], project, [])
    draft = create(users["owner"], project, {"assembly_revision_id": root["revision_id"]})
    frozen = capture(users["owner"], draft, "bom.freeze")
    actor = users["viewer"]
    before = inspect_revision(actor, frozen["revision_id"])
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    assert actor.is_active
    with pytest.raises(Unauthenticated, match="Actor is not active"):
        inspect_revision(actor, frozen["revision_id"])
    get_user_model().objects.filter(pk=actor.pk).update(is_active=True)
    assert inspect_revision(actor, frozen["revision_id"]) == before


def test_bom_root_retained_origin_denial_and_exact_restoration(users, project):
    root = assembly(users["owner"], project, [])
    original = capture(
        users["owner"],
        create(users["owner"], project, {"assembly_revision_id": root["revision_id"]}),
        "bom.freeze",
    )
    remote, _, frozen = adopt_with_remote_origin(users, project, original)
    actor = users["viewer"]
    payload = {"revision_id": frozen["revision_id"]}
    client = api(actor)
    before = inspect_revision(actor, frozen["revision_id"])
    raw = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    revoke(users, remote)
    for read in (
        lambda: inspect_revision(actor, frozen["revision_id"]),
        lambda: op(actor, "bom.read", payload),
    ):
        with pytest.raises(NotFound, match=r"^Project not found\.$"):
            read()
    assert client.get(f"/api/v0/bom/revisions/{frozen['revision_id']}").status_code == 404
    assert post_op(client, "bom.read", payload).status_code == 404
    restore(users, remote)
    assert inspect_revision(actor, frozen["revision_id"]) == before
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == raw


def test_failed_snapshot_batch_does_not_publish_partial_authorization(users, project):
    remote = op(users["owner"], "project.create", {"name": "Restricted batch input"})["project_id"]
    hidden = part(users["owner"], remote, "Synthetic hidden leaf")
    root = assembly(users["owner"], project, [("hidden", hidden)])
    snapshot = Snapshot.objects.select_related("definition").get(pk=root["snapshot_id"])
    completed = set()
    with pytest.raises(NotFound):
        authorize_snapshot(users["viewer"], snapshot, _authorized=completed)
    assert completed == set()
    restore(users, remote)
    authorize_snapshot(users["viewer"], snapshot, _authorized=completed)
    assert completed == {UUID(root["snapshot_id"]), UUID(hidden["snapshot_id"])}


def test_fourteen_occurrences_retain_exact_pins_and_bounded_query_work(users, project):
    owner = users["owner"]
    leaves = [part(owner, project, f"Synthetic leaf {i}") for i in range(8)]
    pairs = [
        assembly(
            owner,
            project,
            [(f"leaf-{2 * i}", leaves[2 * i]), (f"leaf-{2 * i + 1}", leaves[2 * i + 1])],
        )
        for i in range(4)
    ]
    branches = [
        assembly(
            owner,
            project,
            [(f"pair-{2 * i}", pairs[2 * i]), (f"pair-{2 * i + 1}", pairs[2 * i + 1])],
        )
        for i in range(2)
    ]
    root = assembly(owner, project, [("left", branches[0]), ("right", branches[1])])
    draft = create(
        owner,
        project,
        {"assembly_revision_id": root["revision_id"], "policies": [policy([], root, "make")]},
    )
    expected = {
        UUID(value["revision_id"]): value["sha256"] for value in [*leaves, *pairs, *branches, root]
    }
    # Same draft/version and rollback isolate adapter differences. Canonical bytes,
    # exact pins and query ceilings are deterministic; elapsed time is not an SLA.
    bodies = []
    for operation, ceiling in (("bom.freeze", 2000), ("draft.freeze", 1200)):
        with transaction.atomic():
            with CaptureQueriesContext(connection) as queries:
                frozen = capture(owner, draft, operation, idempotency_key=operation)
            assert len(queries) < ceiling
            snapshot = Snapshot.objects.get(pk=frozen["snapshot_id"])
            bodies.append(bytes(snapshot.canonical))
            assert set(snapshot.dependencies.values_list("revision_id", flat=True)) == set(expected)
            assert {
                UUID(pin["revision_id"]): pin["sha256"]
                for pin in json.loads(bodies[-1])["dependencies"]
            } == expected
            transaction.set_rollback(True)
    assert bodies[0] == bodies[1]
    frozen = capture(owner, draft, "bom.freeze", idempotency_key="retained-freeze")
    with CaptureQueriesContext(connection) as queries:
        view = inspect_revision(owner, frozen["revision_id"], "assembly_contents")
    assert len(queries) < 400
    paths = {tuple(row["address"]["path"]) for row in view["rows"]}
    assert paths == {
        tuple(path.split("/"))
        for path in (
            "left",
            "left/pair-0",
            "left/pair-0/leaf-0",
            "left/pair-0/leaf-1",
            "left/pair-1",
            "left/pair-1/leaf-2",
            "left/pair-1/leaf-3",
            "right",
            "right/pair-2",
            "right/pair-2/leaf-4",
            "right/pair-2/leaf-5",
            "right/pair-3",
            "right/pair-3/leaf-6",
            "right/pair-3/leaf-7",
        )
    }
    assert paths == {
        tuple(row["address"]["path"])
        for row in read_assembly(owner, root["snapshot_id"])["occurrences"]
    }
    with CaptureQueriesContext(connection) as queries:
        replayed = capture(owner, draft, "bom.freeze", idempotency_key="retained-freeze")
    assert len(queries) < 2200
    assert replayed == frozen
    with pytest.raises(Conflict):
        capture(owner, draft, "bom.freeze")
    assert Snapshot.objects.get(pk=frozen["snapshot_id"]).sha256 == frozen["sha256"]


@pytest.mark.parametrize("operation", ["bom.freeze", "draft.freeze"])
def test_batch_freeze_checks_dependency_catalog_origin_before_path_and_recovers(
    users, project, operation, monkeypatch
):
    owner = users["owner"]
    original = part(owner, project, "Synthetic adopted leaf")
    remote, _, adopted = adopt_with_remote_origin(users, project, original)
    root = assembly(owner, project, [("left", adopted), ("right", adopted)])
    draft = create(owner, project, {"assembly_revision_id": root["revision_id"]})
    frozen = capture(owner, draft, operation, idempotency_key="origin-freeze")
    baseline = inspect_revision(owner, frozen["revision_id"], "assembly_contents")
    raw = bytes(Snapshot.objects.get(pk=frozen["snapshot_id"]).canonical)
    from specmate.access.models import Membership
    from specmate.assemblies import queries as assembly_queries

    Membership.objects.filter(project_id=remote, user=owner).delete()
    malformed = {
        "assembly_revision_id": root["revision_id"],
        "scope_paths": [["unresolved"]],
    }
    for action in (
        lambda: capture(owner, draft, operation, idempotency_key="origin-freeze"),
        lambda: capture(owner, frozen["draft"], operation),
        lambda: create(owner, project, malformed),
        lambda: inspect_revision(owner, frozen["revision_id"]),
    ):
        with pytest.raises(NotFound):
            action()
    Membership.objects.create(project_id=remote, user=owner, role="owner")
    assert capture(owner, draft, operation, idempotency_key="origin-freeze") == frozen
    assert inspect_revision(owner, frozen["revision_id"], "assembly_contents") == baseline
    assert bytes(Snapshot.objects.get(pk=frozen["snapshot_id"]).canonical) == raw
    with pytest.raises(ValidationFailed, match="context does not resolve"):
        create(owner, project, malformed)
    # Reusing completed authorization does not bypass occurrence expansion bounds.
    monkeypatch.setattr(assembly_queries, "MAX_NODES", 1)
    with pytest.raises(ValidationFailed, match="occurrence limit"):
        inspect_revision(owner, frozen["revision_id"])


def test_bom_root_origin_denial_precedes_wrong_kind_diagnostic(users, project):
    original = part(users["owner"], project, "Synthetic non-BOM")
    remote, _, frozen = adopt_with_remote_origin(users, project, original)
    with pytest.raises(ValidationFailed, match="not a BOM plan"):
        inspect_revision(users["viewer"], frozen["revision_id"])
    revoke(users, remote)
    with pytest.raises(NotFound, match=r"^Project not found\.$"):
        inspect_revision(users["viewer"], frozen["revision_id"])
    restore(users, remote)
    with pytest.raises(ValidationFailed, match="not a BOM plan"):
        inspect_revision(users["viewer"], frozen["revision_id"])
