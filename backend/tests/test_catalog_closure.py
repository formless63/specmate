"""Catalog draft metadata must respect current typed and transitive reference scope."""

import pytest

from specmate.access.models import WorkspaceMember
from specmate.catalog.queries import get_identity
from specmate.operations import NotFound

from .conftest import op
from .test_interfaces import create, freeze, pinout
from .test_transports import api


@pytest.mark.parametrize("kind", ["typed_draft", "generic_base"])
@pytest.mark.parametrize("via", ["query", "api"])
def test_catalog_draft_summary_hides_revoked_reference_closure(users, project, kind, via):
    user = users["owner"]
    remote = op(user, "project.create", {"name": "Private body source"})
    body = freeze(user, create(user, remote["project_id"]))
    pins = op(
        user,
        "definition.create",
        {
            "project_id": project,
            "kind": "pinout",
            "name": "Referenced pinout",
            "content": {"interface": pinout(body)},
        },
    )
    target = pins
    if kind == "generic_base":
        pinned = op(
            user, "draft.freeze", {"draft_id": pins["draft_id"]}, expected_state=pins["state"]
        )
        target = op(
            user,
            "definition.create",
            {"project_id": project, "kind": "part", "name": "Pinned document"},
        )
        op(
            user,
            "draft.freeze",
            {"draft_id": target["draft_id"], "dependencies": [pinned["revision_id"]]},
            expected_state=target["state"],
        )
    identity = get_identity(user, target["definition_id"])
    assert identity["drafts"][0]["draft_id"] == target["draft_id"]
    if kind == "generic_base":
        assert identity["drafts"][0]["dependencies"] == [pinned["revision_id"]]
    WorkspaceMember.objects.filter(user=user, workspace__projects=remote["project_id"]).delete()
    if via == "query":
        with pytest.raises(NotFound):
            get_identity(user, target["definition_id"])
    else:
        response = api(user).get(f"/api/v0/catalog/definitions/{target['definition_id']}")
        assert response.status_code == 404
        assert target["draft_id"] not in response.content.decode()
        assert body["revision_id"] not in response.content.decode()
