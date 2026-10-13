"""Cached outcomes preserve current scope, authority and exact upload identity."""

import hashlib
import io
from dataclasses import replace

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import Installation, Membership
from specmate.builds.models import BuildAttempt
from specmate.design.models import Definition, Revision
from specmate.operations import (
    Context,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
    execute,
    registry,
)
from specmate.sources import blobstore

from . import test_builds as build_tests
from .conftest import op
from .test_transports import api, post_op


@pytest.fixture(name="recipe")
def approved_recipe_fixture(settings):
    return build_tests.recipe.__wrapped__(settings)


@pytest.fixture(name="source")
def build_source_fixture(users, project):
    return build_tests.source.__wrapped__(users, project)


@pytest.fixture(name="build_payload")
def build_payload_fixture(project, source, recipe):
    return build_tests.build_payload.__wrapped__(project, source, recipe)


def request_for(name, user, project, definition):
    expected = None
    if name == "project.create":
        payload = {"name": "Cached synthetic project"}
    elif name == "definition.create":
        payload = {"project_id": project, "kind": "part", "name": "Cached part"}
    elif name == "source.create_original_bundle":
        content = b"synthetic original\n"
        digest = hashlib.sha256(content).hexdigest()
        op(
            user,
            "source.register_blob",
            {
                "project_id": project,
                "sha256": digest,
                "size": len(content),
                "media_type": "text/plain",
            },
            attachments={"content": io.BytesIO(content)},
        )
        payload = {
            "project_id": project,
            "name": "Cached source",
            "files": [
                {
                    "path": "original.txt",
                    "sha256": digest,
                    "media_type": "text/plain",
                    "rights": "synthetic-original",
                }
            ],
        }
    else:
        payload = {"draft_id": definition["draft_id"]}
        if name == "draft.update":
            payload["changes"] = {"value": "synthetic"}
        expected = definition["state"]
    return payload, expected


@pytest.mark.parametrize("via", ["api", "job"])
@pytest.mark.parametrize(
    "name",
    [
        "project.create",
        "definition.create",
        "draft.update",
        "draft.freeze",
        "source.create_original_bundle",
    ],
)
def test_replay_after_membership_revocation_is_not_found(users, project, definition, via, name):
    user = users["owner"]
    payload, expected = request_for(name, user, project, definition)
    options = {"idempotency_key": "retained", "expected_state": expected}
    client = api(user)
    if via == "api":
        first = post_op(client, name, payload, **options)
        assert first.status_code == 200
        stored = first.json()["result"]
    else:
        stored = op(user, name, payload, **options)
    target = stored["project_id"] if name == "project.create" else project
    Membership.objects.filter(project_id=target, user=user).delete()
    if via == "api":
        denied = post_op(client, name, payload, **options)
        assert denied.status_code == 404
        assert denied.json()["error"]["code"] == "not_found"
        assert "result" not in denied.json()
    else:
        with pytest.raises(NotFound):
            op(user, name, payload, **options)


@pytest.mark.parametrize("via", ["api", "job"])
def test_freeze_replay_rechecks_freeze_grant_without_reapplying_old_state(
    users, project, definition, via
):
    user = users["editor"]
    Membership.objects.filter(project_id=project, user=user).update(grants=["design.freeze"])
    payload = {"draft_id": definition["draft_id"]}
    options = {"expected_state": definition["state"], "idempotency_key": "freeze"}
    first = op(user, "draft.freeze", payload, **options)
    assert op(user, "draft.freeze", payload, **options) == first
    Membership.objects.filter(project_id=project, user=user).update(grants=[])
    if via == "api":
        response = post_op(api(user), "draft.freeze", payload, **options)
        assert response.status_code == 403
    else:
        with pytest.raises(PermissionDenied):
            op(user, "draft.freeze", payload, **options)
    assert Revision.objects.count() == 1


def test_replay_rechecks_pinned_dependency_read_scope(users, project, definition):
    owner = users["owner"]
    other = op(owner, "project.create", {"name": "Synthetic dependency scope"})
    dep = op(
        owner,
        "definition.create",
        {
            "project_id": other["project_id"],
            "kind": "part",
            "name": "Pinned part",
        },
    )
    frozen = op(owner, "draft.freeze", {"draft_id": dep["draft_id"]}, expected_state=dep["state"])
    payload = {"draft_id": definition["draft_id"], "dependencies": [frozen["revision_id"]]}
    options = {"expected_state": definition["state"], "idempotency_key": "dependency-freeze"}
    op(owner, "draft.freeze", payload, **options)
    Membership.objects.filter(project_id=other["project_id"], user=owner).delete()
    with pytest.raises(NotFound):
        op(owner, "draft.freeze", payload, **options)
    assert Revision.objects.count() == 2


def test_current_account_status_overrides_stale_authenticated_object(users, project):
    owner = users["owner"]
    payload = {"project_id": project, "kind": "part", "name": "Stale actor part"}
    ctx = Context(user=owner, via="internal", request_id="old-actor", idempotency_key="actor")
    execute("definition.create", ctx, payload)
    get_user_model().objects.filter(pk=owner.pk).update(is_active=False)
    assert owner.is_active  # Deliberately stale object from an in-process caller.
    with pytest.raises(Unauthenticated):
        execute("definition.create", ctx, payload)
    with pytest.raises(Unauthenticated):
        execute("definition.create", replace(ctx, idempotency_key=None), payload)
    assert Definition.objects.count() == 1


def test_replayed_upload_verifies_actual_stream_without_promoting_damaged_bytes(
    users, project, artifact_root
):
    owner = users["owner"]
    content = b"unchanged original\n"
    digest = hashlib.sha256(content).hexdigest()
    payload = {
        "project_id": project,
        "sha256": digest,
        "size": len(content),
        "media_type": "text/plain",
    }
    first = op(
        owner,
        "source.register_blob",
        payload,
        idempotency_key="upload",
        attachments={"content": io.BytesIO(content)},
    )
    with pytest.raises(ValidationFailed, match="does not match"):
        op(
            owner,
            "source.register_blob",
            payload,
            idempotency_key="upload",
            attachments={"content": io.BytesIO(b"!" + content[1:])},
        )
    assert list((artifact_root / "staging").iterdir()) == []
    with blobstore.open_blob(digest) as preserved:
        assert preserved.read() == content
    assert (
        op(
            owner,
            "source.register_blob",
            payload,
            idempotency_key="upload",
            attachments={"content": io.BytesIO(content)},
        )
        == first
    )


def test_build_request_replay_checks_current_recipe_definition(
    users, build_payload, recipe, settings
):
    first = op(users["owner"], "build.request", build_payload, idempotency_key="recipe")
    settings.SPECMATE_APPROVED_RECIPES = {
        recipe["id"]: {**recipe, "image": "example.invalid/test@sha256:" + "2" * 64}
    }
    with pytest.raises(PermissionDenied, match="no longer approved"):
        op(users["owner"], "build.request", build_payload, idempotency_key="recipe")
    assert str(BuildAttempt.objects.get().id) == first["build_id"]


@pytest.mark.parametrize("name", ["build.get", "build.output", "build.poll", "build.dispatch"])
def test_live_reads_and_reconciliation_reject_cached_request_keys(users, name):
    payload = {"build_id": "00000000-0000-4000-8000-000000000001"}
    if name == "build.output":
        payload["output_id"] = "00000000-0000-4000-8000-000000000002"
    with pytest.raises(ValidationFailed, match="fresh evaluation"):
        op(users["owner"], name, payload, idempotency_key="no-stale-status")


def test_cached_operator_action_cannot_replay_through_jobs(users, project, recipe):
    owner = users["owner"]
    Installation.objects.create(owner=owner)
    ctx = Context(user=owner, via="internal", request_id="operator")
    credential = execute(
        "runner.enroll",
        ctx,
        {
            "project_id": project,
            "name": "Synthetic scoped runner",
            "recipe_ids": [recipe["id"]],
        },
    ).result
    payload = {"credential_id": credential["credential_id"]}
    keyed = replace(ctx, idempotency_key="revoke")
    execute("runner.revoke", keyed, payload)
    with pytest.raises(PermissionDenied, match="operator authority"):
        op(owner, "runner.revoke", payload, idempotency_key="revoke")


def test_new_operation_without_replay_guard_fails_closed(users, project, monkeypatch):
    name = "unguarded.create"
    monkeypatch.setitem(registry, name, replace(registry["definition.create"], name=name))
    payload = {"project_id": project, "kind": "part", "name": "Guarded scope"}
    ctx = Context(user=users["owner"], via="job", request_id="custom", idempotency_key="custom")
    execute(name, ctx, payload)
    with pytest.raises(PermissionDenied, match="replay policy"):
        execute(name, ctx, payload)
    assert Definition.objects.count() == 1
