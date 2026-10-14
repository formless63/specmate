"""ACC-FND-001: reusable, orderable, representation and physical identity separation."""

import uuid

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.catalog.models import ManufacturerVariant, PhysicalLot, Representation
from specmate.catalog.queries import get_identity, get_revision_catalog
from specmate.design.models import Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import ensure_member, op
from .scope_helpers import workspace_of
from .test_design import freeze
from .test_sources import ORIGINAL, files, register
from .test_transports import api, post_op


@pytest.fixture
def revision(users, definition):
    return freeze(users["owner"], definition["draft_id"], definition["state"])


@pytest.fixture
def source(users, project):
    register(users["editor"], project, ORIGINAL)
    return op(
        users["editor"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Symbol source",
            "files": files(ORIGINAL),
        },
    )


def variant_payload(revision, part="SYN-100"):
    return {
        "revision_id": revision["revision_id"],
        "manufacturer": "Synthetic Components",
        "part_number": part,
        "association_basis": "Declared catalog association; unqualified.",
    }


def rep_payload(revision, source):
    return {
        "revision_id": revision["revision_id"],
        "kind": "symbol",
        "label": "Logic symbol",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "src/source.txt",
    }


def test_representation_preserves_exact_source_path_including_spaces(users, project, revision):
    register(users["editor"], project, ORIGINAL)
    exact_path = "src/source.txt "
    source = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Exact path fixture",
            "files": files(ORIGINAL) + files(ORIGINAL, path=exact_path),
        },
    )
    payload = {**rep_payload(revision, source), "source_path": exact_path}
    result = op(
        users["editor"],
        "catalog.register_representation",
        payload,
        idempotency_key="exact-representation-path",
    )
    assert result["source_path"] == exact_path
    assert (
        op(
            users["editor"],
            "catalog.register_representation",
            payload,
            idempotency_key="exact-representation-path",
        )
        == result
    )
    ordinary = op(users["editor"], "catalog.register_representation", rep_payload(revision, source))
    assert ordinary["representation_id"] != result["representation_id"]
    assert ordinary["source_path"] == "src/source.txt"


def test_one_definition_two_variants_two_lots_and_representation(
    users, definition, revision, source
):
    before = bytes(Snapshot.objects.get(id=revision["snapshot_id"]).canonical)
    variants = [
        op(users["editor"], "catalog.register_variant", variant_payload(revision, part))
        for part in ("SYN-100", "SYN-200")
    ]
    lots = [
        op(
            users["editor"],
            "catalog.register_lot",
            {
                "revision_id": revision["revision_id"],
                "variant_id": variant["variant_id"],
                "label": "Batch A",
            },
        )
        for variant in variants
    ]
    rep = op(users["editor"], "catalog.register_representation", rep_payload(revision, source))
    identities = {
        definition["definition_id"],
        revision["revision_id"],
        rep["representation_id"],
        *(v["variant_id"] for v in variants),
        *(lot["lot_id"] for lot in lots),
    }
    assert len(identities) == 7
    assert {lot["definition_id"] for lot in lots} == {definition["definition_id"]}
    assert {lot["variant_id"] for lot in lots} == {v["variant_id"] for v in variants}
    assert rep["rights"] == "synthetic-original"
    assert rep["source_bundle_revision_id"] == source["revision_id"]
    listing = get_revision_catalog(users["viewer"], revision["revision_id"])
    assert len(listing["variants"]) == len(listing["lots"]) == 2
    assert len(listing["representations"]) == 1
    assert bytes(Snapshot.objects.get(id=revision["snapshot_id"]).canonical) == before


def test_later_revision_leaves_associations_pinned(users, definition, revision):
    variant = op(users["editor"], "catalog.register_variant", variant_payload(revision))
    later = freeze(users["owner"], definition["draft_id"], revision["draft"]["state"])
    assert get_revision_catalog(users["viewer"], later["revision_id"])["variants"] == []
    assert get_revision_catalog(users["viewer"], revision["revision_id"])["variants"] == [variant]
    assert len(get_identity(users["viewer"], definition["definition_id"])["revisions"]) == 2


def test_same_part_number_does_not_merge_definitions(users, project, revision):
    other = op(
        users["editor"],
        "definition.create",
        {"workspace_id": workspace_of(project), "kind": "part", "name": "Second"},
    )
    other_rev = freeze(users["owner"], other["draft_id"], other["state"])
    a = op(users["editor"], "catalog.register_variant", variant_payload(revision))
    b = op(users["editor"], "catalog.register_variant", variant_payload(other_rev))
    assert a["variant_id"] != b["variant_id"] and a["definition_id"] != b["definition_id"]


@pytest.mark.parametrize(
    "operation",
    ["catalog.register_variant", "catalog.register_lot", "catalog.register_representation"],
)
def test_authorization_replay_and_validation(users, revision, source, operation):
    payload = {
        "catalog.register_variant": variant_payload(revision),
        "catalog.register_lot": {"revision_id": revision["revision_id"], "label": "Batch"},
        "catalog.register_representation": rep_payload(revision, source),
    }[operation]
    for name, error, status in [("viewer", PermissionDenied, 403), ("outsider", NotFound, 404)]:
        with pytest.raises(error):
            op(users[name], operation, payload)
        assert post_op(api(users[name]), operation, payload).status_code == status
    assert post_op(api(), operation, payload).status_code == 401
    first = op(users["editor"], operation, payload, idempotency_key="catalog-1")
    assert op(users["editor"], operation, payload, idempotency_key="catalog-1") == first
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            operation,
            {
                **payload,
                **(
                    {"part_number": "Changed"}
                    if operation.endswith("variant")
                    else {"label": "Changed"}
                ),
            },
            idempotency_key="catalog-1",
        )
    with pytest.raises(ValidationFailed):
        op(users["editor"], operation, {**payload, "unknown": True})


def test_duplicate_variant_and_representation_conflict(users, revision, source):
    for operation, payload in [
        ("catalog.register_variant", variant_payload(revision)),
        ("catalog.register_representation", rep_payload(revision, source)),
    ]:
        op(users["editor"], operation, payload)
        with pytest.raises(Conflict):
            op(users["editor"], operation, payload)
    assert ManufacturerVariant.objects.count() == Representation.objects.count() == 1


def test_lot_variant_revision_mismatch_rolls_back(users, definition, revision):
    variant = op(users["editor"], "catalog.register_variant", variant_payload(revision))
    later = freeze(users["owner"], definition["draft_id"], revision["draft"]["state"])
    payload = {
        "revision_id": later["revision_id"],
        "variant_id": variant["variant_id"],
        "label": "Lot",
    }
    with pytest.raises(ValidationFailed):
        op(users["editor"], "catalog.register_lot", payload, idempotency_key="invalid-lot")
    assert not PhysicalLot.objects.exists()
    with pytest.raises(DatabaseError), transaction.atomic():
        PhysicalLot.objects.create(
            revision_id=later["revision_id"],
            variant_id=variant["variant_id"],
            label="Lot",
            registered_by=users["owner"],
        )


def test_representation_requires_exact_file_and_scoped_source(users, revision, source):
    payload = rep_payload(revision, source)
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "catalog.register_representation",
            {**payload, "source_path": "missing.txt"},
        )
    other = op(users["outsider"], "project.create", {"name": "Private"})["project_id"]
    register(users["outsider"], other, ORIGINAL)
    hidden = op(
        users["outsider"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(other),
            "name": "Hidden",
            "files": files(ORIGINAL),
        },
    )
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "catalog.register_representation",
            {**payload, "source_bundle_revision_id": hidden["revision_id"]},
        )
    assert not Representation.objects.exists()


@pytest.mark.parametrize(
    "table", ["catalog_manufacturervariant", "catalog_representation", "catalog_physicallot"]
)
def test_database_protects_catalog_identity(users, revision, source, table):
    op(users["editor"], "catalog.register_variant", variant_payload(revision))
    op(users["editor"], "catalog.register_representation", rep_payload(revision, source))
    op(
        users["editor"],
        "catalog.register_lot",
        {"revision_id": revision["revision_id"], "label": "Lot"},
    )
    for sql in (f"UPDATE {table} SET id = id", f"DELETE FROM {table}"):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql)


def test_api_register_and_scoped_paginated_reads(users, definition, revision):
    client = api(users["editor"])
    response = post_op(client, "catalog.register_variant", variant_payload(revision))
    assert response.status_code == 200
    url = f"/api/v0/catalog/revisions/{revision['revision_id']}"
    assert client.get(url).json()["variants"] == [response.json()["result"]]
    assert client.get(url + "?offset=1&limit=1").json()["variants"] == []
    assert client.get(url + "?limit=101").status_code == 422
    assert api(users["outsider"]).get(url).status_code == 404
    assert api().get(url).status_code == 401
    identity = f"/api/v0/catalog/definitions/{definition['definition_id']}"
    assert client.get(identity).json()["definition_id"] == definition["definition_id"]
    assert api(users["outsider"]).get(identity).status_code == 404


def test_two_consumers_reuse_one_definition_revision(users, project, revision, definition):
    from specmate.design.models import Revision, SnapshotDependency

    consumers = []
    for name in ("Left module", "Right module"):
        draft = op(
            users["editor"],
            "definition.create",
            {
                "workspace_id": workspace_of(project),
                "kind": "assembly",
                "name": name,
            },
        )
        consumers.append(
            freeze(users["owner"], draft["draft_id"], draft["state"], [revision["revision_id"]])
        )
    pins = SnapshotDependency.objects.filter(snapshot_id__in=[c["snapshot_id"] for c in consumers])
    assert pins.count() == 2
    assert set(pins.values_list("revision_id", flat=True)) == {uuid.UUID(revision["revision_id"])}
    assert Revision.objects.get(id=revision["revision_id"]).definition_id == uuid.UUID(
        definition["definition_id"]
    )


def test_accessible_cross_workspace_source_still_rejected_by_service_and_database(
    users, revision, other_workspace
):
    from specmate.sources.models import SourceBundleFile

    from .conftest import member

    # The owner can read both workspaces, yet a pin never crosses a workspace boundary.
    member(users["owner"], "editor", workspace=other_workspace)
    other = op(
        users["owner"],
        "project.create",
        {"name": "Separate source scope", "workspace_id": other_workspace},
    )["project_id"]
    register(users["owner"], other, ORIGINAL)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(other),
            "name": "Other scope",
            "files": files(ORIGINAL),
        },
    )
    with pytest.raises(ValidationFailed):
        op(users["owner"], "catalog.register_representation", rep_payload(revision, source))
    with pytest.raises(DatabaseError), transaction.atomic():
        Representation.objects.create(
            revision_id=revision["revision_id"],
            kind="symbol",
            label="Source",
            source_file=SourceBundleFile.objects.get(revision_id=source["revision_id"]),
            registered_by=users["owner"],
        )


@pytest.mark.django_db(transaction=True)
def test_competing_variant_registrations_create_one_identity(users, revision):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections

    barrier = Barrier(2)

    def register_competing():
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                op(users["editor"], "catalog.register_variant", variant_payload(revision))
                return "created"
            except Conflict:
                return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: register_competing(), range(2)))
    assert sorted(results) == ["conflict", "created"]
    assert ManufacturerVariant.objects.count() == 1


def test_draft_dependency_disclosure_rechecks_current_access(users, project, definition, revision):
    from specmate.access.models import WorkspaceMember

    other_project = op(users["owner"], "project.create", {"name": "Reusable library"})["project_id"]
    ensure_member(users["editor"], "viewer", project=other_project)
    other = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(other_project),
            "kind": "part",
            "name": "Shared dependency",
        },
    )
    dependency = freeze(users["owner"], other["draft_id"], other["state"])
    freeze(
        users["owner"],
        definition["draft_id"],
        revision["draft"]["state"],
        [dependency["revision_id"]],
    )
    assert get_identity(users["editor"], definition["definition_id"])["drafts"][0][
        "dependencies"
    ] == [dependency["revision_id"]]
    WorkspaceMember.objects.filter(workspace__projects=other_project, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        get_identity(users["editor"], definition["definition_id"])


def test_replay_guard_rechecks_current_authority_without_appending(users, project, revision):
    from specmate.access.models import WorkspaceMember
    from specmate.catalog.contracts import RegisterVariant
    from specmate.catalog.operations import authorize_catalog_replay
    from specmate.operations import Context

    payload = variant_payload(revision)
    result = op(users["editor"], "catalog.register_variant", payload)
    context = Context(user=users["editor"], via="internal", request_id="replay-guard")
    parsed = RegisterVariant.model_validate(payload)
    authorize_catalog_replay(context, parsed, result)
    assert ManufacturerVariant.objects.count() == 1
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["editor"]).update(
        role="viewer"
    )
    with pytest.raises(PermissionDenied):
        authorize_catalog_replay(context, parsed, result)
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        authorize_catalog_replay(context, parsed, result)
