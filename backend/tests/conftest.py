import itertools

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import Membership
from specmate.jobs.adapter import run_operation

_ids = itertools.count()


@pytest.fixture(autouse=True)
def artifact_root(settings, tmp_path):
    settings.SPECMATE_ARTIFACT_ROOT = str(tmp_path / "artifacts")
    return tmp_path / "artifacts"


@pytest.fixture
def users(db):
    User = get_user_model()
    return {
        name: User.objects.create_user(username=name, password="unused-test-password")
        for name in ("owner", "editor", "viewer", "outsider")
    }


def op(user, operation, payload, **ctx):
    """Invoke through the trusted jobs adapter (same execute() path as the API)."""
    return run_operation(
        on_behalf_of=user.pk,
        operation=operation,
        payload=payload,
        request_id=f"req-{next(_ids)}",
        **ctx,
    ).result


@pytest.fixture
def project(users):
    result = op(users["owner"], "project.create", {"name": "Synthetic bench"})
    pid = result["project_id"]
    Membership.objects.create(project_id=pid, user=users["editor"], role="editor")
    Membership.objects.create(project_id=pid, user=users["viewer"], role="viewer")
    return pid


@pytest.fixture
def definition(users, project):
    return op(
        users["owner"],
        "definition.create",
        {"project_id": project, "kind": "wire_stock", "name": "Demo stock", "content": {"a": 1}},
    )
