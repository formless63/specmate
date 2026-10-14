"""Workspace library, project list and resolved references (FND-007, LIB-005)."""

import uuid

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from specmate.access.models import Project
from specmate.knowledge.models import KnowledgeItem
from specmate.operations import NotFound, PermissionDenied, ValidationFailed
from specmate.physical_units.models import PhysicalUnit
from specmate.sources.models import SourceBundle
from specmate.workspace.contracts import ListLibrary, ListWorkspaceProjects, ResolveLibraryRecord
from specmate.workspace.queries import library_record, list_library, list_projects, project_detail

from .conftest import op
from .test_project_references import add, part, read
from .test_transports import api


def library(user, **payload):
    return list_library(user, ListLibrary(**payload))


def projects(user, **payload):
    return list_projects(user, ListWorkspaceProjects(**payload))


def labels(page):
    return [row["label"] for row in page["results"]]


def test_library_lists_the_workspace_collection_without_an_owning_project(
    users, workspace, other_workspace, project
):
    part(users["contributor"], workspace, "Shared connector")
    op(
        users["outsider"],
        "definition.create",
        {"workspace_id": other_workspace, "kind": "part", "name": "Foreign connector"},
    )
    page = library(users["viewer"])
    assert labels(page) == ["Shared connector"]
    row = page["results"][0]
    assert "project_id" not in row and "project_name" not in row
    assert row["family"] == "definition" and row["kind"] == "part"
    assert row["latest_revision"] is None and row["changed_at"] is not None
    assert row["referenceable"] and row["referenced"] is None
    assert row["used_in"] == [] and row["used_in_total"] == 0
    assert page["workspace_id"] == workspace and page["project_id"] is None
    # The outsider sees only its own workspace; asking for ours is indistinguishable.
    assert labels(library(users["outsider"])) == ["Foreign connector"]
    with pytest.raises(NotFound) as hidden:
        library(users["outsider"], workspace_id=workspace)
    with pytest.raises(NotFound) as missing:
        library(users["outsider"], workspace_id=str(uuid.uuid4()))
    assert str(hidden.value) == str(missing.value)


def test_used_in_comes_from_active_floating_and_exact_references(users, workspace, project):
    item = part(users["owner"], workspace, "Pinned connector", freeze=True)
    second = op(users["contributor"], "project.create", {"name": "Archive bench"})["project_id"]
    add(users["contributor"], project, "definition", item["definition_id"])
    exact = add(users["contributor"], second, "revision", item["revision_id"], role="spare")
    row = library(users["viewer"])["results"][0]
    assert row["latest_revision"] == 1 and row["used_in_total"] == 2
    assert row["latest_revision_id"] == item["revision_id"]
    uses = {use["project_name"]: use for use in row["used_in"]}
    assert uses["Synthetic bench"]["pin"] == "floating"
    assert uses["Synthetic bench"]["revision"] is None
    assert uses["Archive bench"] == {
        "reference_id": exact["reference"]["reference_id"],
        "project_id": second,
        "project_name": "Archive bench",
        "archived": False,
        "pin": "exact",
        "revision": 1,
        "role": "spare",
    }
    op(users["owner"], "project.archive", {"project_id": second}, expected_state=exact["state"])
    uses = library(users["viewer"])["results"][0]["used_in"]
    assert {use["project_name"]: use["archived"] for use in uses} == {
        "Synthetic bench": False,
        "Archive bench": True,
    }
    state = read(users["owner"], project)
    reference = state["references"][0]["reference_id"]
    op(
        users["owner"],
        "project.remove_reference",
        {"project_id": project, "reference_id": reference, "reason": "Superseded"},
        expected_state=state["state"],
    )
    uses = library(users["viewer"])["results"][0]["used_in"]
    assert [use["project_name"] for use in uses] == ["Archive bench"]


def test_project_context_lists_its_references_first_and_pages_completely(users, workspace, project):
    names = [f"Stock {index}" for index in range(7)]
    created = {name: part(users["owner"], workspace, name) for name in names}
    # Reference two older items; they must lead the list at project scope.
    state = None
    for name in ("Stock 1", "Stock 3"):
        state = add(
            users["owner"], project, "definition", created[name]["definition_id"], state=state
        )["state"]
    context = library(users["viewer"], project_id=project)
    assert labels(context)[:2] == ["Stock 3", "Stock 1"]
    assert [row["referenced"] for row in context["results"]] == [True, True] + [False] * 5
    only = library(users["viewer"], project_id=project, referenced_only=True)
    assert labels(only) == ["Stock 3", "Stock 1"]
    seen, after, pages = [], None, 0
    while True:
        page = library(users["viewer"], project_id=project, limit=3, after=after)
        assert len(page["results"]) <= 3
        seen += labels(page)
        pages += 1
        after = page["next_after"]
        if after is None:
            break
    assert pages == 3 and seen == labels(context)
    assert labels(library(users["viewer"]))[0] == "Stock 6"  # newest first without context
    with pytest.raises(ValidationFailed):
        library(users["viewer"], after="not-a-cursor")
    with pytest.raises(ValidationFailed):
        library(users["viewer"], project_id=project, after=page_cursor_without_flag(users))


def page_cursor_without_flag(users):
    return library(users["viewer"], limit=1)["next_after"]


def test_context_project_outside_the_workspace_is_not_found(users, other_workspace, project):
    foreign = op(
        users["outsider"], "project.create", {"name": "Foreign", "workspace_id": other_workspace}
    )["project_id"]
    with pytest.raises(NotFound) as hidden:
        library(users["viewer"], project_id=foreign)
    with pytest.raises(NotFound) as missing:
        library(users["viewer"], project_id=str(uuid.uuid4()))
    assert str(hidden.value) == str(missing.value)
    with pytest.raises(NotFound):
        project_detail(users["outsider"], project)


def test_kind_and_text_filters_and_contract_bounds(users, workspace):
    part(users["owner"], workspace, "Ribbon")
    op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace, "kind": "harness", "name": "Main loom"},
    )
    assert labels(library(users["viewer"], kinds=["harness"])) == ["Main loom"]
    assert labels(library(users["viewer"], query="ribb")) == ["Ribbon"]
    with pytest.raises(ValueError):
        ListLibrary(kinds=["Not A Slug"])
    with pytest.raises(ValueError):
        ListLibrary(limit=101)


def test_other_families_list_bundles_units_stock_and_facts(users, workspace, project):
    item = part(users["owner"], workspace, "Bench board", freeze=True)
    bundle = SourceBundle.objects.create(
        workspace_id=workspace, name="Board sources", role="original", created_by=users["owner"]
    )
    unit = PhysicalUnit.objects.create(
        workspace_id=workspace,
        revision_id=item["revision_id"],
        serial="SN-0001",
        origin="assembled",
        assertion_source="Synthetic traveler",
        assertion_status="observed",
        registered_by=users["owner"],
        request_id="unit-1",
    )
    state = add(users["owner"], project, "source_bundle", str(bundle.id))["state"]
    add(users["owner"], project, "physical_unit", str(unit.id), state=state)
    bundles = library(users["viewer"], family="source_bundle")["results"]
    assert [(row["label"], row["kind"], row["detail"]) for row in bundles] == [
        ("Board sources", "original", "Original")
    ]
    assert bundles[0]["used_in"][0]["project_name"] == "Synthetic bench"
    units = library(users["viewer"], family="physical_unit", project_id=project)["results"]
    assert [(row["label"], row["detail"], row["referenced"]) for row in units] == [
        ("SN-0001", "Bench board r1", True)
    ]
    stock = library(users["viewer"], family="stock_account", project_id=project)
    assert stock["results"] == []
    facts = library(users["viewer"], family="fact_subject")
    assert facts["results"] == []


def test_library_reads_are_bounded_regardless_of_project_count(users, workspace, project):
    items = [part(users["owner"], workspace, f"Item {index}") for index in range(4)]
    for index in range(3):
        extra = op(users["owner"], "project.create", {"name": f"Bench {index}"})["project_id"]
        state = None
        for item in items:
            state = add(users["owner"], extra, "definition", item["definition_id"], state=state)[
                "state"
            ]
    with CaptureQueriesContext(connection) as small:
        library(users["viewer"], project_id=project)
    for index in range(3, 9):
        extra = op(users["owner"], "project.create", {"name": f"Bench {index}"})["project_id"]
        add(users["owner"], extra, "definition", items[0]["definition_id"])
    with CaptureQueriesContext(connection) as large:
        page = library(users["viewer"], project_id=project)
    assert len(large.captured_queries) == len(small.captured_queries)
    assert max(row["used_in_total"] for row in page["results"]) == 9


def test_project_list_reports_references_dependents_and_delete_eligibility(
    users, workspace, project
):
    item = part(users["owner"], workspace)
    add(users["owner"], project, "definition", item["definition_id"])
    KnowledgeItem.objects.create(
        workspace_id=workspace, project_id=project, kind="decision", created_by=users["owner"]
    )
    mine = op(users["contributor"], "project.create", {"name": "Contributor bench"})["project_id"]
    page = projects(users["contributor"])
    assert page["role"] == "contributor" and "project.edit" in page["permissions"]
    rows = {row["name"]: row for row in page["results"]}
    assert list(rows) == ["Contributor bench", "Synthetic bench"]
    shared = rows["Synthetic bench"]
    assert shared["references"] == [{"kind": "definition", "count": 1}]
    assert shared["dependents"] == {"knowledge.knowledgeitem": 1}
    assert not shared["can_delete"] and shared["created_by"] == "owner"
    assert rows["Contributor bench"]["can_delete"]
    # Only the creator or an admin may delete; viewers never.
    assert not projects(users["editor"])["results"][0]["can_delete"]
    assert projects(users["owner"])["results"][0]["can_delete"]
    assert not any(row["can_delete"] for row in projects(users["viewer"])["results"])
    state = read(users["contributor"], mine)["state"]
    op(users["contributor"], "project.archive", {"project_id": mine}, expected_state=state)
    assert [row["name"] for row in projects(users["viewer"])["results"]] == ["Synthetic bench"]
    archived = projects(users["viewer"], include_archived=True)
    assert archived["total"] == 2 and archived["results"][0]["archived"]
    first = projects(users["viewer"], include_archived=True, limit=1)
    rest = projects(users["viewer"], include_archived=True, after=first["next_after"])
    assert [r["name"] for r in first["results"] + rest["results"]] == [
        "Contributor bench",
        "Synthetic bench",
    ]
    with pytest.raises(NotFound):
        projects(users["outsider"], workspace_id=workspace)


def test_project_detail_resolves_reference_labels(users, workspace, project):
    item = part(users["owner"], workspace, "Detail connector", freeze=True)
    state = add(users["owner"], project, "definition", item["definition_id"])["state"]
    add(users["owner"], project, "revision", item["revision_id"], role="pinned", state=state)
    detail = project_detail(users["viewer"], project)
    assert detail["name"] == "Synthetic bench" and detail["created_by"] == "owner"
    assert detail["state"] == read(users["viewer"], project)["state"]
    assert detail["permissions"] == ["workspace.read"]
    assert not detail["can_delete"]
    rows = {row["pin"]: row for row in detail["references"]}
    assert rows["floating"]["label"] == "Detail connector"
    assert rows["floating"]["item_kind"] == "part"
    assert rows["floating"]["revision"] is None and rows["floating"]["latest_revision"] == 1
    assert rows["exact"]["revision"] == 1 and rows["exact"]["role"] == "pinned"
    assert rows["exact"]["definition_id"] == item["definition_id"]
    assert project_detail(users["owner"], project)["can_delete"]


def test_delete_is_for_the_creator_or_an_admin_and_archived_projects_remain_deletable(
    users, workspace
):
    def create(user, name):
        created = op(user, "project.create", {"name": name})
        return created["project_id"], created["state"]

    owned, state = create(users["contributor"], "Contributor bench")
    with pytest.raises(PermissionDenied):
        op(users["editor"], "project.delete", {"project_id": owned}, expected_state=state)
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "project.delete", {"project_id": owned}, expected_state=state)
    archived = op(
        users["contributor"], "project.archive", {"project_id": owned}, expected_state=state
    )
    deleted = op(
        users["contributor"],
        "project.delete",
        {"project_id": owned},
        expected_state=archived["state"],
    )
    assert deleted["deleted"] and not Project.objects.filter(id=owned).exists()
    other, state = create(users["editor"], "Editor bench")
    op(users["owner"], "project.delete", {"project_id": other}, expected_state=state)
    assert not Project.objects.filter(id=other).exists()


def test_workspace_routes_serve_the_same_reads(users, workspace, project):
    part(users["owner"], workspace, "Routed part")
    viewer = api(users["viewer"])
    library_page = viewer.get("/api/v0/workspace/library?family=definition").json()
    assert labels(library_page) == ["Routed part"]
    listed = viewer.get("/api/v0/workspace/projects").json()
    assert [row["name"] for row in listed["results"]] == ["Synthetic bench"]
    detail = viewer.get(f"/api/v0/workspace/projects/{project}").json()
    assert detail["project_id"] == project
    outsider = api(users["outsider"])
    assert outsider.get(f"/api/v0/workspace/projects/{project}").status_code == 404
    assert outsider.get(f"/api/v0/workspace/library?workspace_id={workspace}").status_code == 404


def resolve(user, record_id, **payload):
    return library_record(user, record_id, ResolveLibraryRecord(**payload))


def test_one_record_resolves_by_id_in_any_family_without_an_existence_signal(
    users, workspace, other_workspace, project
):
    item = part(users["owner"], workspace, "Linked board", freeze=True)
    bundle = SourceBundle.objects.create(
        workspace_id=workspace, name="Linked sources", role="original", created_by=users["owner"]
    )
    add(users["owner"], project, "definition", item["definition_id"])
    row = resolve(users["viewer"], item["definition_id"])
    assert (row["label"], row["family"], row["latest_revision"]) == (
        "Linked board",
        "definition",
        1,
    )
    assert row["referenced"] is None and row["used_in_total"] == 1
    assert resolve(users["viewer"], item["definition_id"], project_id=project)["referenced"] is True
    assert resolve(users["viewer"], bundle.id)["family"] == "source_bundle"
    # Another workspace's member and a random id get the same answer; so does a foreign context.
    with pytest.raises(NotFound) as hidden:
        resolve(users["outsider"], item["definition_id"])
    with pytest.raises(NotFound) as missing:
        resolve(users["viewer"], uuid.uuid4())
    assert str(hidden.value) == str(missing.value)
    with pytest.raises(NotFound):
        resolve(users["outsider"], item["definition_id"], workspace_id=workspace)
    foreign = op(
        users["outsider"], "project.create", {"name": "Foreign", "workspace_id": other_workspace}
    )["project_id"]
    with pytest.raises(NotFound):
        resolve(users["viewer"], item["definition_id"], project_id=foreign)
    viewer = api(users["viewer"])
    routed = viewer.get(f"/api/v0/workspace/library/{item['definition_id']}?project_id={project}")
    assert routed.status_code == 200 and routed.json()["referenced"] is True
    outsider = api(users["outsider"])
    assert outsider.get(f"/api/v0/workspace/library/{item['definition_id']}").status_code == 404
    assert outsider.get(f"/api/v0/workspace/library/{uuid.uuid4()}").status_code == 404
    assert viewer.get("/api/v0/workspace/library/not-a-uuid").status_code in (404, 422)
