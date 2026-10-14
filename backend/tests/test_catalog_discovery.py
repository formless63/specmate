"""LIB-005: search and exact pin traversal disclose only current authorized records."""

import pytest

from specmate.access.models import WorkspaceMember
from specmate.operations import NotFound, ValidationFailed

from .conftest import ensure_member, op
from .test_catalog import variant_payload
from .test_design import freeze
from .test_inventory import assertion
from .test_sources import ORIGINAL, files, register
from .test_transports import api


def create_part(user, project, name):
    return op(user, "definition.create", {"project_id": project, "kind": "part", "name": name})


def search(user, kind, query, **options):
    return op(user, "catalog.search", {"kind": kind, "query": query, **options})


def test_search_sources_catalog_and_stock_with_current_authority(users, project):
    owner = users["owner"]
    part = create_part(owner, project, "Caliper bracket")
    revision = freeze(owner, part["draft_id"], part["state"])
    variant = op(owner, "catalog.register_variant", variant_payload(revision, "SYN-731"))
    lot = op(
        owner,
        "catalog.register_lot",
        {
            "revision_id": revision["revision_id"],
            "variant_id": variant["variant_id"],
            "label": "Batch Copper",
        },
    )
    location = op(owner, "inventory.create_location", {"project_id": project, "name": "Drawer B"})
    stock = op(
        owner,
        "inventory.open_stock",
        assertion(
            None, lot_id=lot["lot_id"], location_id=location["location_id"], dimension="count"
        ),
    )
    register(owner, project, ORIGINAL)
    source = op(
        owner,
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Bracket source",
            "files": files(ORIGINAL),
        },
    )
    viewer = users["viewer"]
    assert search(viewer, "project", "Synthetic")["results"][0]["project_id"] == str(project)
    assert (
        search(viewer, "definition", "Caliper")["results"][0]["record_id"] == part["definition_id"]
    )
    assert (
        search(viewer, "source_bundle", "src/source.txt")["results"][0]["record_id"]
        == source["bundle_id"]
    )
    assert search(viewer, "variant", "SYN-731")["results"][0]["record_id"] == variant["variant_id"]
    assert search(viewer, "lot", "Copper")["results"][0]["record_id"] == lot["lot_id"]
    assert search(viewer, "stock", "Drawer B")["results"][0]["record_id"] == stock["account_id"]
    WorkspaceMember.objects.filter(workspace__projects=project, user=viewer).delete()
    for kind, text in (
        ("project", "Synthetic"),
        ("definition", "Caliper"),
        ("source_bundle", "source.txt"),
        ("variant", "SYN-731"),
        ("lot", "Copper"),
        ("stock", "Drawer B"),
    ):
        assert search(viewer, kind, text)["results"] == []
    with pytest.raises(NotFound):
        search(viewer, "definition", "Caliper", project_id=str(project))


def test_where_used_filters_hidden_parents_and_closure_before_paging(users, project):
    owner = users["owner"]
    target = create_part(owner, project, "Target pin")
    pinned = freeze(owner, target["draft_id"], target["state"])
    remote = op(owner, "project.create", {"name": "Other private bench"})["project_id"]
    hidden_dependency = create_part(owner, remote, "Remote dependency")
    hidden_revision = freeze(owner, hidden_dependency["draft_id"], hidden_dependency["state"])
    parents = []
    for index, dependencies in enumerate(
        (
            [pinned["revision_id"]],
            [pinned["revision_id"], hidden_revision["revision_id"]],
            [pinned["revision_id"]],
        )
    ):
        parent = create_part(owner, project, f"Parent {index}")
        frozen = freeze(owner, parent["draft_id"], parent["state"], dependencies)
        parents.append((frozen["snapshot_id"], parent["definition_id"]))
    remote_parent = create_part(owner, remote, "Invisible parent")
    freeze(owner, remote_parent["draft_id"], remote_parent["state"], [pinned["revision_id"]])
    viewer = users["viewer"]
    expected = sorted([parents[0][0], parents[2][0]])
    first = op(viewer, "catalog.where_used", {"revision_id": pinned["revision_id"], "limit": 1})
    assert [r["snapshot_id"] for r in first["results"]] == expected[:1]
    assert first["next_after"] == expected[0]
    second = op(
        viewer,
        "catalog.where_used",
        {
            "revision_id": pinned["revision_id"],
            "limit": 1,
            "after": first["next_after"],
        },
    )
    assert [r["snapshot_id"] for r in second["results"]] == expected[1:]
    assert second["next_after"] is None
    assert all(r["relation"] == "exact_revision_pin" for r in first["results"] + second["results"])
    with pytest.raises(NotFound):
        op(
            viewer,
            "catalog.where_used",
            {
                "revision_id": pinned["revision_id"],
                "after": parents[1][0],
            },
        )
    with pytest.raises(NotFound):
        op(viewer, "catalog.where_used", {"revision_id": hidden_revision["revision_id"]})
    WorkspaceMember.objects.filter(workspace__projects=project, user=viewer).delete()
    with pytest.raises(NotFound):
        op(viewer, "catalog.where_used", {"revision_id": pinned["revision_id"]})


def test_search_cursor_is_current_visible_match_and_query_is_literal(users, project):
    owner = users["owner"]
    a = create_part(owner, project, "Literal % bracket")
    create_part(owner, project, "Ordinary bracket")
    assert [r["record_id"] for r in search(users["viewer"], "definition", "%")["results"]] == [
        a["definition_id"]
    ]
    with pytest.raises(NotFound):
        search(
            users["viewer"], "definition", "bracket", after="00000000-0000-0000-0000-000000000000"
        )
    with pytest.raises(NotFound):
        search(users["viewer"], "definition", "Ordinary", after=a["definition_id"])
    with pytest.raises(ValidationFailed):
        search(users["viewer"], "definition", "\x00")
    with pytest.raises(ValidationFailed):
        search(users["viewer"], "definition", " ")
    with pytest.raises(ValidationFailed):
        search(users["viewer"], "definition", "bracket", limit=101)


def test_search_skips_catalog_record_after_dependency_access_is_revoked(users, project):
    owner = users["owner"]
    remote = op(owner, "project.create", {"name": "Remote source"})["project_id"]
    ensure_member(users["viewer"], "viewer", project=remote)
    dependency = create_part(owner, remote, "Remote fixture")
    pinned = freeze(owner, dependency["draft_id"], dependency["state"])
    part = create_part(owner, project, "Scoped fixture")
    revision = freeze(owner, part["draft_id"], part["state"], [pinned["revision_id"]])
    variant = op(owner, "catalog.register_variant", variant_payload(revision, "REV-CHECK"))
    viewer = users["viewer"]
    assert (
        search(viewer, "variant", "REV-CHECK")["results"][0]["record_id"] == variant["variant_id"]
    )
    WorkspaceMember.objects.filter(workspace__projects=remote, user=viewer).delete()
    assert search(viewer, "variant", "REV-CHECK")["results"] == []
    with pytest.raises(NotFound):
        search(viewer, "variant", "REV-CHECK", after=variant["variant_id"])


def test_http_queries_validate_page_and_share_authority(users, project, definition):
    target = freeze(users["owner"], definition["draft_id"], definition["state"])
    client = api(users["viewer"])
    found = client.get(
        "/api/v0/catalog/search", {"query": "Demo", "kind": "definition", "limit": "1"}
    )
    assert found.status_code == 200
    assert found.json()["results"][0]["record_id"] == definition["definition_id"]
    assert (
        client.get("/api/v0/catalog/search", {"query": "Demo", "limit": "101"}).status_code == 422
    )
    outsider = api(users["outsider"])
    assert outsider.get("/api/v0/catalog/search", {"query": "Demo"}).json()["results"] == []
    params = {"revision_id": target["revision_id"], "limit": "1"}
    assert client.get("/api/v0/catalog/where-used", params).json()["results"] == []
    assert outsider.get("/api/v0/catalog/where-used", params).status_code == 404
