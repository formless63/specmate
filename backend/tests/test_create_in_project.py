"""Creating an item from a project's context also references it, atomically."""

import io
from hashlib import sha256

import pytest

from specmate.access.models import Project, ProjectReference
from specmate.design.models import Definition
from specmate.operations import Conflict, NotFound, PermissionDenied
from specmate.sources.models import SourceBundle

from .conftest import op
from .scope_helpers import workspace_of
from .test_wire_stock import fixture


def active(project_id):
    return list(ProjectReference.objects.filter(project_id=project_id, removed_at__isnull=True))


def bundle_payload(users, workspace, **extra):
    content = b"synthetic board bytes"
    digest = sha256(content).hexdigest()
    op(
        users["contributor"],
        "source.register_blob",
        {
            "workspace_id": workspace_of(workspace),
            "sha256": digest,
            "size": len(content),
            "media_type": "application/octet-stream",
        },
        attachments={"content": io.BytesIO(content)},
    )
    return {
        "workspace_id": workspace_of(workspace),
        "name": "Synthetic package",
        "files": [
            {
                "path": "board.kicad_pcb",
                "sha256": digest,
                "media_type": "application/octet-stream",
                "rights": "MIT",
            }
        ],
        **extra,
    }


def test_definition_and_stock_created_in_a_project_are_referenced(users, workspace, project):
    part = op(
        users["contributor"],
        "definition.create",
        {"workspace_id": workspace, "kind": "part", "name": "Here", "project_id": project},
    )
    stock = op(
        users["contributor"],
        "wire_stock.create",
        {
            "workspace_id": workspace,
            "name": "Stock here",
            "stock": fixture(),
            "project_id": project,
        },
    )
    rows = active(project)
    assert {str(r.definition_id) for r in rows} == {part["definition_id"], stock["definition_id"]}
    assert {r.kind for r in rows} == {"definition"}
    # Without a project context nothing is referenced.
    op(
        users["contributor"],
        "definition.create",
        {"workspace_id": workspace, "kind": "part", "name": "Elsewhere"},
    )
    assert len(active(project)) == 2


def test_bundle_and_intake_reference_the_source_bundle_once(users, workspace, project):
    created = op(
        users["contributor"],
        "source.create_original_bundle",
        bundle_payload(users, workspace, project_id=project),
    )
    rows = active(project)
    assert [r.kind for r in rows] == ["source_bundle"]
    bundle = SourceBundle.objects.get(revisions__id=created["revision_id"])
    assert rows[0].source_bundle_id == bundle.id
    # Registering an intake from the same project does not duplicate the reference.
    op(
        users["contributor"],
        "pcb.register_intake",
        {
            "workspace_id": workspace_of(workspace),
            "source_revision_id": created["revision_id"],
            "board_path": "board.kicad_pcb",
            "project_id": project,
        },
    )
    assert len(active(project)) == 1
    # A second project gains its own reference from an intake on the same bundle.
    other = op(users["contributor"], "project.create", {"name": "Other bench"})["project_id"]
    op(
        users["contributor"],
        "pcb.register_intake",
        {
            "workspace_id": workspace_of(workspace),
            "source_revision_id": created["revision_id"],
            "board_path": "board.kicad_pcb",
            "project_id": other,
        },
    )
    assert [r.source_bundle_id for r in active(other)] == [bundle.id]


def test_project_context_is_permission_checked_and_atomic(
    users, workspace, project, other_workspace
):
    payload = {"workspace_id": workspace, "kind": "part", "name": "Denied"}
    # A viewer cannot create at all; an outsider cannot see the project.
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "definition.create", {**payload, "project_id": project})
    with pytest.raises(NotFound):
        op(users["outsider"], "definition.create", {**payload, "project_id": project})
    # A project in another workspace is not found, and the item is not created.
    foreign = op(
        users["outsider"], "project.create", {"name": "Foreign", "workspace_id": other_workspace}
    )
    with pytest.raises(NotFound):
        op(
            users["contributor"],
            "definition.create",
            {**payload, "project_id": foreign["project_id"]},
        )
    # An archived project refuses the reference and the creation rolls back.
    archived = op(users["owner"], "project.create", {"name": "Old bench"})
    state = op(users["owner"], "project.references", {"project_id": archived["project_id"]})[
        "state"
    ]
    op(
        users["owner"],
        "project.archive",
        {"project_id": archived["project_id"]},
        expected_state=state,
    )
    before = Definition.objects.count()
    with pytest.raises(Conflict):
        op(users["owner"], "definition.create", {**payload, "project_id": archived["project_id"]})
    assert Definition.objects.count() == before
    assert Project.objects.get(id=project).references.count() == 0
