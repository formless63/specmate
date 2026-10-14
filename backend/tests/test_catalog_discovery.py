"""LIB-005: workspace search, exact pins and project references; nothing crosses workspaces."""

import pytest

from specmate.operations import NotFound, ValidationFailed

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_catalog import variant_payload
from .test_design import freeze
from .test_inventory import assertion
from .test_project_references import add
from .test_sources import ORIGINAL, files, register
from .test_transports import api


def create_part(user, project, name):
    return op(
        user,
        "definition.create",
        {"workspace_id": workspace_of(project), "kind": "part", "name": name},
    )


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
    location = op(
        owner,
        "inventory.create_location",
        {"workspace_id": workspace_of(project), "name": "Drawer B"},
    )
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
            "workspace_id": workspace_of(project),
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
    remove_member(viewer)
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


def test_where_used_pages_workspace_pins_and_lists_referencing_projects(
    users, project, other_workspace
):
    owner = users["owner"]
    target = create_part(owner, project, "Target pin")
    pinned = freeze(owner, target["draft_id"], target["state"])
    second_project = op(owner, "project.create", {"name": "Other bench"})["project_id"]
    other_dependency = create_part(owner, second_project, "Other dependency")
    other_revision = freeze(owner, other_dependency["draft_id"], other_dependency["state"])
    parents = []
    for index, dependencies in enumerate(
        (
            [pinned["revision_id"]],
            [pinned["revision_id"], other_revision["revision_id"]],
            [pinned["revision_id"]],
        )
    ):
        parent = create_part(owner, project, f"Parent {index}")
        frozen = freeze(owner, parent["draft_id"], parent["state"], dependencies)
        parents.append((frozen["snapshot_id"], parent["definition_id"]))
    viewer = users["viewer"]
    # Every same-workspace parent is a use, whichever project it was created from.
    expected = sorted(snapshot for snapshot, _ in parents)
    first = op(viewer, "catalog.where_used", {"revision_id": pinned["revision_id"], "limit": 2})
    assert [r["snapshot_id"] for r in first["results"]] == expected[:2]
    assert first["next_after"] == expected[1]
    second = op(
        viewer,
        "catalog.where_used",
        {"revision_id": pinned["revision_id"], "limit": 2, "after": first["next_after"]},
    )
    assert [r["snapshot_id"] for r in second["results"]] == expected[2:]
    assert second["next_after"] is None
    assert all(r["relation"] == "exact_revision_pin" for r in first["results"] + second["results"])
    assert first["project_references"] == [] and not first["project_references_truncated"]

    # Project references are reported separately and say which kind of use they are.
    add(owner, project, "revision", pinned["revision_id"], role="component")
    add(owner, second_project, "definition", target["definition_id"], role="candidate")
    add(owner, second_project, "definition", parents[2][1], role="assembly")
    unrelated = op(owner, "project.create", {"name": "Unrelated bench"})["project_id"]
    add(owner, unrelated, "revision", other_revision["revision_id"], role="component")
    uses = op(viewer, "catalog.where_used", {"revision_id": pinned["revision_id"]})
    assert sorted(
        (r["project_id"], r["relation"], r["role"]) for r in uses["project_references"]
    ) == sorted(
        [
            (project, "project_reference_exact", "component"),
            (second_project, "project_reference_floating", "candidate"),
        ]
    )
    assert all(r["in_project"] is False for r in uses["project_references"])

    # At project scope that project's own uses come first and are marked.
    scoped = op(
        viewer,
        "catalog.where_used",
        {"revision_id": pinned["revision_id"], "project_id": second_project, "limit": 1},
    )
    assert scoped["project_id"] == second_project
    assert [(r["snapshot_id"], r["in_project"]) for r in scoped["results"]] == [
        (parents[2][0], True)
    ]
    assert scoped["project_references"][0]["project_id"] == second_project
    assert scoped["project_references"][0]["in_project"] is True
    rest = op(
        viewer,
        "catalog.where_used",
        {
            "revision_id": pinned["revision_id"],
            "project_id": second_project,
            "after": scoped["next_after"],
        },
    )
    assert [r["snapshot_id"] for r in rest["results"]] == sorted([parents[0][0], parents[1][0]])
    assert not any(r["in_project"] for r in rest["results"])

    # A foreign workspace's revision, cursor or project context is indistinguishable
    # from a missing one, and nothing from it appears in the uses.
    foreign = create_foreign_part(users, other_workspace)
    for payload in (
        {"revision_id": foreign["revision_id"]},
        {"revision_id": pinned["revision_id"], "after": foreign["snapshot_id"]},
        {"revision_id": pinned["revision_id"], "project_id": foreign["project_id"]},
    ):
        with pytest.raises(NotFound):
            op(viewer, "catalog.where_used", payload)
    remove_member(viewer)
    with pytest.raises(NotFound):
        op(viewer, "catalog.where_used", {"revision_id": pinned["revision_id"]})


def create_foreign_part(users, other_workspace):
    outsider = users["outsider"]
    foreign_project = op(outsider, "project.create", {"name": "Foreign bench"})["project_id"]
    part = op(
        outsider,
        "definition.create",
        {"workspace_id": workspace_of(other_workspace), "kind": "part", "name": "Caliper foreign"},
    )
    return {
        **freeze(outsider, part["draft_id"], part["state"]),
        "definition_id": part["definition_id"],
        "project_id": foreign_project,
    }


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


def test_project_scope_lists_its_references_first_and_never_hides_library_items(
    users, project, other_workspace
):
    owner = users["owner"]
    parts = [create_part(owner, project, f"Bench fixture {index}") for index in range(3)]
    revision = freeze(owner, parts[2]["draft_id"], parts[2]["state"])
    add(owner, project, "definition", parts[1]["definition_id"])
    add(owner, project, "revision", revision["revision_id"], role="pinned")
    create_foreign_part(users, other_workspace)
    viewer = users["viewer"]
    library = search(viewer, "definition", "fixture")
    assert [r["record_id"] for r in library["results"]] == sorted(p["definition_id"] for p in parts)
    assert all("in_project" not in r for r in library["results"])
    referenced = sorted([parts[1]["definition_id"], parts[2]["definition_id"]])
    page = search(viewer, "definition", "fixture", project_id=project, limit=2)
    assert [(r["record_id"], r["in_project"]) for r in page["results"]] == [
        (referenced[0], True),
        (referenced[1], True),
    ]
    rest = search(viewer, "definition", "fixture", project_id=project, after=page["next_after"])
    assert [(r["record_id"], r["in_project"]) for r in rest["results"]] == [
        (parts[0]["definition_id"], False)
    ]
    assert rest["next_after"] is None
    # Variants inherit the use of their exact revision or its definition.
    variant = op(owner, "catalog.register_variant", variant_payload(revision, "REF-FIRST"))
    found = search(viewer, "variant", "REF-FIRST", project_id=project)["results"]
    assert [(r["record_id"], r["in_project"]) for r in found] == [(variant["variant_id"], True)]
    # The foreign workspace's same-named part never appears, even to its own admin's query
    # from the primary workspace scope, and its admin cannot use this project as context.
    with pytest.raises(NotFound):
        search(users["outsider"], "definition", "fixture", project_id=project)
    assert [r["label"] for r in search(users["outsider"], "definition", "Caliper")["results"]] == [
        "Caliper foreign"
    ]


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
