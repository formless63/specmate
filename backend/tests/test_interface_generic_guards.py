"""Generic draft paths must preserve typed interface validation and exact source scope."""

from uuid import UUID

import pytest

from specmate.access.models import WorkspaceMember
from specmate.design.models import Snapshot
from specmate.operations import NotFound, ValidationFailed
from specmate.queries import get_draft, get_revision

from .conftest import op
from .test_interfaces import BODY, create, freeze, pinout


def test_present_typed_interface_cannot_bypass_validation_through_generic_commands(users, project):
    incomplete = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "pinout",
            "name": "Unfinished pinout",
        },
    )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {"draft_id": incomplete["draft_id"]},
            expected_state=incomplete["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.update",
            {
                "draft_id": incomplete["draft_id"],
                "changes": {"interface": {"kind": "pinout"}},
            },
            expected_state=incomplete["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "definition.create",
            {
                "project_id": project,
                "kind": "part",
                "name": "Wrong typed owner",
                "content": {"interface": BODY},
            },
        )
    assert get_draft(users["owner"], incomplete["draft_id"])["state"] == incomplete["state"]


def test_generic_freeze_derives_pinned_body_and_rejects_wrong_dependency_list(users, project):
    body = freeze(users["owner"], create(users["owner"], project))
    pins = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "pinout",
            "name": "Generic pinout",
            "content": {"interface": pinout(body)},
        },
    )
    unrelated = freeze(users["owner"], create(users["owner"], project))
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {
                "draft_id": pins["draft_id"],
                "dependencies": [unrelated["revision_id"]],
            },
            expected_state=pins["state"],
        )
    revision = op(
        users["owner"], "draft.freeze", {"draft_id": pins["draft_id"]}, expected_state=pins["state"]
    )
    assert set(
        Snapshot.objects.get(id=revision["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    ) == {UUID(body["revision_id"])}


def test_revoked_exact_body_blocks_generic_reads_stale_conflicts_and_retained_replays(
    users, project
):
    remote = op(users["owner"], "project.create", {"name": "Private connector bodies"})
    body = freeze(users["owner"], create(users["owner"], remote["project_id"]))
    pins = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "pinout",
            "name": "Scoped pinout",
            "content": {"interface": pinout(body)},
        },
        idempotency_key="generic-pinout",
    )
    revision = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": pins["draft_id"]},
        expected_state=pins["state"],
        idempotency_key="freeze-pins",
    )
    WorkspaceMember.objects.filter(
        workspace__projects=remote["project_id"], user=users["owner"]
    ).delete()
    for read in [
        lambda: get_draft(users["owner"], pins["draft_id"]),
        lambda: get_revision(users["owner"], revision["revision_id"]),
    ]:
        with pytest.raises(NotFound):
            read()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "draft.update",
            {"draft_id": pins["draft_id"], "changes": {}},
            expected_state=pins["state"],
        )
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "draft.freeze",
            {"draft_id": pins["draft_id"]},
            expected_state=pins["state"],
            idempotency_key="freeze-pins",
        )
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "definition.create",
            {
                "project_id": project,
                "kind": "pinout",
                "name": "Scoped pinout",
                "content": {"interface": pinout(body)},
            },
            idempotency_key="generic-pinout",
        )


@pytest.mark.parametrize("capture", ["draft.snapshot", "draft.freeze"])
def test_generic_dependency_capture_rechecks_transitive_exact_scope(users, project, capture):
    remote = op(users["owner"], "project.create", {"name": "Revoked body source"})
    body = freeze(users["owner"], create(users["owner"], remote["project_id"]))
    pins = freeze(users["owner"], create(users["owner"], project, pinout(body)))
    parent = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "part",
            "name": "Generic dependency parent",
        },
    )
    WorkspaceMember.objects.filter(
        workspace__projects=remote["project_id"], user=users["owner"]
    ).delete()
    before = Snapshot.objects.count()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            capture,
            {
                "draft_id": parent["draft_id"],
                "dependencies": [pins["revision_id"]],
            },
            expected_state=parent["state"],
        )
    assert Snapshot.objects.count() == before
    assert get_draft(users["owner"], parent["draft_id"])["state"] == parent["state"]
