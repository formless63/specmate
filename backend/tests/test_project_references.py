"""Projects reference workspace items; they own none (FND-007, docs/DOMAIN.md)."""

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.access.models import Project, ProjectReference, Workspace
from specmate.design.models import Definition, Revision, SnapshotDependency
from specmate.knowledge.models import KnowledgeItem
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.operations.models import IdempotencyRecord
from specmate.queries import list_projects

from .conftest import member, op


def read(user, project, **extra):
    return op(user, "project.references", {"project_id": project, **extra})


def part(user, workspace, name="Shared connector", freeze=False):
    created = op(
        user, "definition.create", {"workspace_id": workspace, "kind": "part", "name": name}
    )
    if not freeze:
        return created
    frozen = op(
        user, "draft.freeze", {"draft_id": created["draft_id"]}, expected_state=created["state"]
    )
    return {**created, **frozen}


def add(user, project, kind, target, role="component", state=None, **options):
    return op(
        user,
        "project.add_reference",
        {"project_id": project, "kind": kind, "target_id": target, "role": role},
        expected_state=state or read(user, project)["state"],
        **options,
    )


def test_project_creation_is_contributor_authority_and_owns_nothing(users, workspace):
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "project.create", {"name": "Viewer bench"})
    created = op(
        users["contributor"], "project.create", {"name": "Bench", "purpose": "Synthetic loom"}
    )
    assert created["workspace_id"] == workspace and created["references"] == []
    assert created["purpose"] == "Synthetic loom" and not created["archived"]
    # Creating items never needs a project and never adds a reference.
    item = part(users["contributor"], workspace)
    assert str(Definition.objects.get(id=item["definition_id"]).workspace_id) == workspace
    assert read(users["viewer"], created["project_id"])["references"] == []


def test_floating_and_exact_references_share_items_across_projects(users, workspace, project):
    item = part(users["owner"], workspace, freeze=True)
    second = op(users["contributor"], "project.create", {"name": "Second bench"})["project_id"]
    floating = add(users["contributor"], project, "definition", item["definition_id"])
    exact = add(
        users["contributor"],
        second,
        "revision",
        item["revision_id"],
        role="pinned connector",
    )
    assert floating["reference"]["pin"] == "floating"
    assert exact["reference"]["pin"] == "exact"
    assert exact["reference"]["target_id"] == item["revision_id"]
    # A second project may use the same definition; the item is untouched.
    add(users["editor"], second, "definition", item["definition_id"])
    definition = Definition.objects.get(id=item["definition_id"])
    assert definition.name == "Shared connector"
    assert Revision.objects.filter(definition=definition).count() == 1
    assert {r["kind"] for r in read(users["viewer"], second)["references"]} == {
        "definition",
        "revision",
    }
    with pytest.raises(PermissionDenied):
        add(users["viewer"], project, "revision", item["revision_id"])


def test_reference_edits_are_state_checked_and_duplicates_conflict(users, workspace, project):
    item = part(users["owner"], workspace)
    before = read(users["owner"], project)["state"]
    first = add(users["owner"], project, "definition", item["definition_id"], state=before)
    with pytest.raises(Conflict) as stale:
        add(users["owner"], project, "definition", item["definition_id"], "other", state=before)
    assert stale.value.details == {"current_state": first["state"]}
    with pytest.raises(Conflict):
        add(users["owner"], project, "definition", item["definition_id"])
    # The same item may play a different role.
    add(users["owner"], project, "definition", item["definition_id"], role="spare")
    assert len(read(users["owner"], project)["references"]) == 2


def test_removal_is_recorded_and_leaves_the_item_and_other_uses(users, workspace, project):
    item = part(users["owner"], workspace)
    other = op(users["owner"], "project.create", {"name": "Other bench"})["project_id"]
    added = add(users["owner"], project, "definition", item["definition_id"])
    add(users["owner"], other, "definition", item["definition_id"])
    removed = op(
        users["contributor"],
        "project.remove_reference",
        {
            "project_id": project,
            "reference_id": added["reference"]["reference_id"],
            "reason": "Replaced by a variant",
        },
        expected_state=added["state"],
    )
    assert removed["reference"]["removed"] and removed["state"] != added["state"]
    assert read(users["owner"], project)["references"] == []
    history = read(users["owner"], project, include_removed=True)["references"]
    assert [r["removal_reason"] for r in history] == ["Replaced by a variant"]
    assert len(read(users["owner"], other)["references"]) == 1
    assert Definition.objects.filter(id=item["definition_id"]).exists()
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "project.remove_reference",
            {
                "project_id": project,
                "reference_id": added["reference"]["reference_id"],
                "reason": "Again",
            },
            expected_state=removed["state"],
        )


def test_foreign_and_missing_targets_are_indistinguishable(users, project):
    foreign = op(users["outsider"], "project.create", {"name": "Foreign bench"})
    hidden = part(users["outsider"], foreign["workspace_id"], "Foreign part")
    errors = []
    for target in (hidden["definition_id"], "00000000-0000-0000-0000-000000000000"):
        with pytest.raises(NotFound) as error:
            add(users["owner"], project, "definition", target)
        errors.append(error.value.as_dict())
    assert errors[0] == errors[1]
    with pytest.raises(NotFound):
        add(users["outsider"], project, "definition", hidden["definition_id"], state="unknown")


def test_archive_hides_the_project_and_keeps_references(users, workspace, project):
    item = part(users["owner"], workspace)
    added = add(users["owner"], project, "definition", item["definition_id"])
    archived = op(
        users["contributor"],
        "project.archive",
        {"project_id": project},
        expected_state=added["state"],
    )
    assert archived["archived"] and len(archived["references"]) == 1
    assert project not in {p["project_id"] for p in list_projects(users["viewer"])}
    assert project in {
        p["project_id"] for p in list_projects(users["viewer"], include_archived=True)
    }
    with pytest.raises(Conflict):
        add(users["owner"], project, "definition", item["definition_id"], role="spare")
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "project.rename",
            {"project_id": project, "name": "Renamed"},
            expected_state=archived["state"],
        )
    restored = op(
        users["owner"],
        "project.archive",
        {"project_id": project, "archived": False},
        expected_state=archived["state"],
    )
    assert not restored["archived"] and len(restored["references"]) == 1


def test_delete_only_when_nothing_depends_and_items_stay(users, workspace, project):
    item = part(users["owner"], workspace)
    added = add(users["owner"], project, "definition", item["definition_id"])
    note = KnowledgeItem.objects.create(
        workspace_id=workspace, project_id=project, kind="decision", created_by=users["owner"]
    )
    with pytest.raises(Conflict) as blocked:
        op(users["owner"], "project.delete", {"project_id": project}, expected_state=added["state"])
    assert blocked.value.details == {"dependents": {"knowledge.knowledgeitem": 1}}
    other = op(users["owner"], "project.create", {"name": "Disposable bench"})["project_id"]
    reference = add(users["owner"], other, "definition", item["definition_id"])
    deleted = op(
        users["contributor"],
        "project.delete",
        {"project_id": other},
        expected_state=reference["state"],
    )
    assert deleted == {"project_id": other, "workspace_id": workspace, "deleted": True}
    assert not Project.objects.filter(id=other).exists()
    assert not ProjectReference.objects.filter(project_id=other).exists()
    assert Definition.objects.filter(id=item["definition_id"]).exists()
    assert ProjectReference.objects.filter(project_id=project).count() == 1
    assert KnowledgeItem.objects.filter(id=note.id).exists()


def test_keyed_reference_replay_uses_workspace_namespace(users, workspace, project):
    item = part(users["owner"], workspace)
    state = read(users["owner"], project)["state"]
    options = {"expected_state": state, "idempotency_key": "reference"}
    payload = {
        "project_id": project,
        "kind": "definition",
        "target_id": item["definition_id"],
        "role": "component",
    }
    first = op(users["editor"], "project.add_reference", payload, **options)
    assert op(users["editor"], "project.add_reference", payload, **options) == first
    assert IdempotencyRecord.objects.get().scope == f"workspace:{workspace}"
    member(users["editor"], "viewer")
    with pytest.raises(PermissionDenied):
        op(users["editor"], "project.add_reference", payload, **options)


def raw(statement, params=()):
    with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(statement, params)


def test_database_keeps_references_append_only_and_inside_the_workspace(users, workspace, project):
    item = part(users["owner"], workspace)
    added = add(users["owner"], project, "definition", item["definition_id"])
    reference_id = added["reference"]["reference_id"]
    raw("UPDATE access_projectreference SET role = 'changed' WHERE id = %s", [reference_id])
    raw("DELETE FROM access_projectreference WHERE id = %s", [reference_id])
    foreign = op(users["outsider"], "project.create", {"name": "Foreign bench"})
    hidden = part(users["outsider"], foreign["workspace_id"], "Foreign part")
    with pytest.raises(DatabaseError), transaction.atomic():
        ProjectReference.objects.create(
            project_id=project,
            kind="definition",
            definition_id=hidden["definition_id"],
            role="component",
            added_by=users["owner"],
            request_id="raw",
        )
    raw(
        "UPDATE access_project SET workspace_id = %s WHERE id = %s",
        [foreign["workspace_id"], project],
    )
    raw(
        "UPDATE design_definition SET workspace_id = %s WHERE id = %s",
        [foreign["workspace_id"], item["definition_id"]],
    )


def test_database_keeps_pins_and_project_context_inside_one_workspace(users, workspace, project):
    local = part(users["owner"], workspace, "Local part", freeze=True)
    foreign_project = op(users["outsider"], "project.create", {"name": "Foreign bench"})
    hidden = part(users["outsider"], foreign_project["workspace_id"], "Foreign", freeze=True)
    with pytest.raises(DatabaseError), transaction.atomic():
        SnapshotDependency.objects.create(
            snapshot_id=Revision.objects.get(id=local["revision_id"]).snapshot_id,
            revision_id=hidden["revision_id"],
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        KnowledgeItem.objects.create(
            workspace_id=workspace,
            project_id=foreign_project["project_id"],
            kind="note",
            created_by=users["owner"],
        )
    assert Workspace.objects.count() == 2
