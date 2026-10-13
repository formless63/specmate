"""Choice lists preserve exact authority and cursors while bounding repeated work."""

from types import SimpleNamespace
from uuid import UUID

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext

from specmate.access.models import Membership
from specmate.design.models import Revision
from specmate.mechanical_sources.api import list_targets
from specmate.operations import NotFound, Unauthenticated
from specmate.queries import get_revision

from .conftest import op
from .test_bom import assembly, part
from .test_mechanical_sources import create, mec_target
from .test_shared_read_authority import adopt_with_remote_origin, restore, revoke
from .test_sources import ORIGINAL, files, register, sha
from .test_transports import api


def expected_row(revision):
    return {
        "revision_id": str(revision.id),
        "snapshot_sha256": revision.snapshot.sha256,
        "name": revision.definition.name,
        "number": revision.number,
        "kind": revision.definition.kind,
        "board": None,
        "components": [],
        "models": [],
        "models_truncated": False,
    }


def test_repeated_choice_closures_keep_exact_rows_with_less_query_work(users, project):
    leaf = part(users["owner"], project, "Original shared choice leaf")
    branch = assembly(users["owner"], project, [("leaf", leaf)])
    for index in range(12):
        assembly(users["owner"], project, [(f"use-{index}", branch)])
    revisions = list(Revision.objects.select_related("definition", "snapshot").order_by("id"))
    expected = {"targets": [expected_row(r) for r in revisions], "next_after": None}
    actor = users["viewer"]
    # Preserve the prior independent, fully authorized read as a resource-work baseline.
    with CaptureQueriesContext(connection) as prior:
        assert [expected_row(get_revision(actor, r.id)) for r in revisions] == expected["targets"]
    with CaptureQueriesContext(connection) as current:
        actual = list_targets(SimpleNamespace(user=actor), UUID(project), after=None)
    assert actual == expected
    assert len(current) < len(prior)
    assert (
        api(actor).get(f"/api/v0/mechanical-sources/projects/{project}/targets").json() == expected
    )


def test_choice_pagination_keeps_exact_fifty_row_boundary(users, project):
    for index in range(53):
        part(users["owner"], project, f"Original choice {index}")
    revisions = list(Revision.objects.select_related("definition", "snapshot").order_by("id"))
    request = SimpleNamespace(user=users["viewer"])
    first = list_targets(request, UUID(project), after=None)
    assert first == {
        "targets": [expected_row(r) for r in revisions[:50]],
        "next_after": str(revisions[49].id),
    }
    assert list_targets(request, UUID(project), after=UUID(first["next_after"])) == {
        "targets": [expected_row(r) for r in revisions[50:]],
        "next_after": None,
    }


def test_completed_choice_call_never_retains_catalog_authority(users, project):
    original = assembly(users["owner"], project, [])
    remote, _, _ = adopt_with_remote_origin(users, project, original)
    request = SimpleNamespace(user=users["viewer"])
    before = list_targets(request, UUID(project), after=None)
    client = api(users["viewer"])
    revoke(users, remote)
    with pytest.raises(NotFound):
        list_targets(request, UUID(project), after=None)
    assert client.get(f"/api/v0/mechanical-sources/projects/{project}/targets").status_code == 404
    restore(users, remote)
    assert list_targets(request, UUID(project), after=None) == before


def test_choice_call_refreshes_captured_actor(users, project):
    part(users["owner"], project, "Original captured-actor choice")
    actor = users["viewer"]
    request = SimpleNamespace(user=actor)
    before = list_targets(request, UUID(project), after=None)
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    assert actor.is_active
    with pytest.raises(Unauthenticated):
        list_targets(request, UUID(project), after=None)
    get_user_model().objects.filter(pk=actor.pk).update(is_active=True)
    assert list_targets(request, UUID(project), after=None) == before


def test_registered_source_revocation_is_fresh_for_every_choice_call(users, project):
    remote = op(users["owner"], "project.create", {"name": "Original choice source"})["project_id"]
    Membership.objects.create(project_id=remote, user=users["viewer"], role="viewer")
    register(users["owner"], remote, ORIGINAL)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {"project_id": remote, "name": "Preserved choice input", "files": files(ORIGINAL)},
    )
    target = mec_target.__wrapped__(users, project)
    draft = create(
        users["owner"],
        project,
        {
            "item_role": "hardware",
            "sources": [
                {
                    "local_id": "information",
                    "source_revision_id": source["revision_id"],
                    "source_manifest_sha256": source["manifest_sha256"],
                    "files": [
                        {
                            "path": "src/source.txt",
                            "sha256": sha(ORIGINAL),
                            "rights": "synthetic-original",
                            "role": "supporting",
                            "format": "other",
                        }
                    ],
                }
            ],
            "targets": [
                {
                    "local_id": "hardware",
                    "role": "hardware",
                    "revision_id": target["revision_id"],
                    "snapshot_sha256": target["sha256"],
                    "basis": "Declared synthetic hardware input",
                }
            ],
            "models": [],
            "limitations": ["No geometry or physical qualification"],
        },
    )
    frozen = op(
        users["owner"],
        "mechanical_source.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    request = SimpleNamespace(user=users["viewer"])
    before = list_targets(request, UUID(project), after=None)
    assert frozen["revision_id"] in {r["revision_id"] for r in before["targets"]}
    revoke(users, remote)
    with pytest.raises(NotFound):
        list_targets(request, UUID(project), after=None)
    restore(users, remote)
    assert list_targets(request, UUID(project), after=None) == before
