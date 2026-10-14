"""Generic operations must preserve the same assembly authority and exact closure."""

from uuid import UUID

import pytest

from specmate.access.models import WorkspaceMember
from specmate.design.models import Snapshot
from specmate.operations import NotFound, ValidationFailed
from specmate.queries import get_draft, get_revision

from .conftest import op
from .test_assemblies import create, occ, part


def test_generic_capture_derives_exact_closure_and_rejects_unrelated_pins(users, project):
    _, child = part(users["owner"], project)
    root = create(users["owner"], project, [occ("board", child)])
    _, unrelated = part(users["owner"], project)
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {
                "draft_id": root["draft_id"],
                "dependencies": [unrelated["revision_id"]],
            },
            expected_state=root["state"],
        )
    frozen = op(
        users["owner"], "draft.freeze", {"draft_id": root["draft_id"]}, expected_state=root["state"]
    )
    assert set(
        Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    ) == {UUID(child["revision_id"])}


def test_revoked_child_is_hidden_before_generic_reads_conflicts_and_replays(users, project):
    child_project = op(users["owner"], "project.create", {"name": "Restricted components"})
    _, child = part(users["owner"], child_project["project_id"])
    root = create(users["owner"], project, [occ("private-board", child)])
    payload = {"draft_id": root["draft_id"]}
    frozen = op(
        users["owner"],
        "draft.freeze",
        payload,
        expected_state=root["state"],
        idempotency_key="freeze-assembly",
    )
    WorkspaceMember.objects.filter(
        workspace__projects=child_project["project_id"], user=users["owner"]
    ).delete()
    for read in [
        lambda: get_draft(users["owner"], root["draft_id"]),
        lambda: get_revision(users["owner"], frozen["revision_id"]),
    ]:
        with pytest.raises(NotFound):
            read()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "draft.update",
            {"draft_id": root["draft_id"], "changes": {}},
            expected_state=root["state"],
        )
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "draft.freeze",
            payload,
            expected_state=root["state"],
            idempotency_key="freeze-assembly",
        )


def test_generic_create_cannot_capture_an_inaccessible_child(users, project):
    other = op(users["outsider"], "project.create", {"name": "Hidden components"})
    _, child = part(users["outsider"], other["project_id"])
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "definition.create",
            {
                "project_id": project,
                "kind": "assembly",
                "name": "Unauthorized assembly",
                "content": {"assembly": {"occurrences": [occ("board", child)]}},
            },
        )
