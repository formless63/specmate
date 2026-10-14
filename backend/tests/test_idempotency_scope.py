"""FND-006: idempotency keys are namespaced by workspace after current authority checks."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier
from uuid import uuid4

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.access.models import Project, WorkspaceMember
from specmate.design.models import Definition
from specmate.operations import (
    Conflict,
    Context,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    execute,
    registry,
)
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import revision_scope, workspace_scope

from .conftest import member, op
from .scope_helpers import workspace_of
from .test_transports import api, post_op


def payload(workspace, name="Synthetic component"):
    return {"workspace_id": workspace_of(workspace), "kind": "part", "name": name}


def keyed_context(user, key="same-key"):
    return Context(user=user, via="internal", request_id="scope-test", idempotency_key=key)


@pytest.mark.parametrize("via", ["api", "job"])
def test_same_actor_operation_key_is_independent_per_workspace(
    users, workspace, other_workspace, via
):
    user = users["owner"]
    member(user, "admin", workspace=other_workspace)

    def create(workspace_id):
        if via == "api":
            response = post_op(
                api(user), "definition.create", payload(workspace_id), idempotency_key="same-key"
            )
            assert response.status_code == 200
            return response.json()["result"]
        return op(user, "definition.create", payload(workspace_id), idempotency_key="same-key")

    a, b = create(workspace), create(other_workspace)
    assert a["definition_id"] != b["definition_id"]
    assert create(workspace) == a and create(other_workspace) == b
    assert set(IdempotencyRecord.objects.values_list("scope", flat=True)) == {
        f"workspace:{workspace}",
        f"workspace:{other_workspace}",
    }
    assert Definition.objects.count() == 2


def test_projects_of_one_workspace_share_its_namespace(users, workspace, project):
    from specmate.knowledge.models import KnowledgeItem

    user = users["owner"]
    other = op(user, "project.create", {"name": "Other synthetic scope"})["project_id"]
    note = {
        "workspace_id": workspace,
        "project_id": project,
        "kind": "note",
        "content": {"title": "Synthetic note", "body": "Synthetic."},
    }
    first = execute("knowledge.create", keyed_context(user), note).result
    assert first["workspace_id"] == workspace
    # Another project in the same workspace is context, not a separate namespace.
    with pytest.raises(IdempotencyMismatch):
        execute("knowledge.create", keyed_context(user), {**note, "project_id": other})
    assert IdempotencyRecord.objects.get().scope == f"workspace:{workspace}"
    assert KnowledgeItem.objects.count() == 1


def test_same_workspace_changed_payload_still_mismatches(users, workspace):
    user = users["owner"]
    execute("definition.create", keyed_context(user), payload(workspace))
    with pytest.raises(IdempotencyMismatch):
        execute("definition.create", keyed_context(user), payload(workspace, "Different"))
    assert Definition.objects.count() == 1


def test_removed_membership_is_checked_before_cached_fingerprint_or_result(users, workspace):
    user = users["owner"]
    execute("definition.create", keyed_context(user), payload(workspace))
    WorkspaceMember.objects.filter(workspace_id=workspace, user=user).delete()
    client = api(user)
    exact = post_op(client, "definition.create", payload(workspace), idempotency_key="same-key")
    changed = post_op(
        client, "definition.create", payload(workspace, "Changed"), idempotency_key="same-key"
    )
    absent = post_op(client, "definition.create", payload(str(uuid4())), idempotency_key="same-key")
    assert exact.status_code == changed.status_code == absent.status_code == 404
    assert exact.json() == changed.json() == absent.json()
    assert IdempotencyRecord.objects.count() == 1


def test_project_creation_uses_the_workspace_namespace(users, workspace):
    user = users["owner"]
    ctx = keyed_context(user)
    first = execute("project.create", ctx, {"name": "Keyed project"})
    again = execute("project.create", ctx, {"name": "Keyed project"})
    assert again.replayed and first.result == again.result
    assert IdempotencyRecord.objects.get().scope == f"workspace:{workspace}"
    assert Project.objects.count() == 1


@pytest.mark.parametrize(
    "value",
    [None, "legacy", "workspace:not-a-uuid", "project:{uuid}", "workspace:{uuid} "],
)
def test_missing_or_invalid_scope_hook_fails_before_effect(users, workspace, monkeypatch, value):
    original = registry["definition.create"]
    name = "extension.create"
    hook = None if value is None else (lambda ctx, parsed: value.format(uuid=workspace))
    monkeypatch.setitem(registry, name, replace(original, name=name, idempotency_scope=hook))
    with pytest.raises(PermissionDenied, match="scope policy"):
        execute(name, keyed_context(users["owner"]), payload(workspace))
    assert not Definition.objects.exists()
    assert not IdempotencyRecord.objects.exists()


def test_explicit_domain_scope_hook_uses_authorized_workspace(users, workspace, monkeypatch):
    original = registry["definition.create"]
    name = "extension.create"
    monkeypatch.setitem(
        registry,
        name,
        replace(
            original,
            name=name,
            idempotency_scope=lambda ctx, parsed: workspace_scope(ctx, parsed.workspace_id),
            authorize_replay=lambda ctx, parsed, stored: workspace_scope(ctx, parsed.workspace_id),
        ),
    )
    ctx = keyed_context(users["owner"])
    first = execute(name, ctx, payload(workspace))
    assert execute(name, ctx, payload(workspace)).result == first.result
    assert IdempotencyRecord.objects.get().scope == f"workspace:{workspace}"


def test_revision_scope_helper_resolves_workspace_and_rechecks_membership(
    users, workspace, definition
):
    frozen = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": definition["draft_id"]},
        expected_state=definition["state"],
    )
    assert (
        revision_scope(keyed_context(users["viewer"]), frozen["revision_id"])
        == f"workspace:{workspace}"
    )
    with pytest.raises(NotFound):
        revision_scope(keyed_context(users["outsider"]), frozen["revision_id"])


def test_replay_rechecks_current_role(users, workspace):
    user = users["editor"]
    ctx = keyed_context(user)
    execute("definition.create", ctx, payload(workspace))
    WorkspaceMember.objects.filter(workspace_id=workspace, user=user).update(role="viewer")
    with pytest.raises(PermissionDenied):
        execute("definition.create", ctx, payload(workspace))
    assert Definition.objects.count() == 1


@pytest.mark.parametrize("same_workspace", [True, False])
@pytest.mark.django_db(transaction=True)
def test_concurrent_keys_preserve_per_workspace_effects(
    users, workspace, other_workspace, monkeypatch, same_workspace
):
    user = users["owner"]
    member(user, "admin", workspace=other_workspace)
    other = workspace if same_workspace else other_workspace
    barrier = Barrier(2)
    original = registry["definition.create"]

    def synchronized_handler(ctx, parsed):
        barrier.wait(timeout=10)
        return original.handler(ctx, parsed)

    monkeypatch.setitem(
        registry, "definition.create", replace(original, handler=synchronized_handler)
    )

    def create(workspace_id):
        try:
            try:
                return execute(
                    "definition.create", keyed_context(user), payload(workspace_id)
                ).result
            except Conflict:
                return None
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, [workspace, other]))
    expected = 1 if same_workspace else 2
    assert sum(result is not None for result in results) == expected
    assert Definition.objects.count() == IdempotencyRecord.objects.count() == expected


@pytest.mark.parametrize("scope", ["", "legacy", "project:{uuid}"])
def test_database_rejects_invalid_or_retired_namespace(users, workspace, scope):
    with pytest.raises(DatabaseError), transaction.atomic():
        IdempotencyRecord.objects.create(
            actor=users["owner"],
            scope=scope.format(uuid=workspace),
            operation="example",
            key="key",
            fingerprint="0" * 64,
            result={},
        )


def test_derived_source_and_build_targets_use_their_workspace(users, workspace, project, settings):
    from . import test_builds as build_tests
    from .test_sources import ORIGINAL, files, register

    user = users["owner"]
    register(user, project, ORIGINAL)
    source = op(
        user,
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Scope source",
            "files": files(ORIGINAL),
        },
    )
    options = {"idempotency_key": "scoped-target"}
    derived_payload = {"source_revision_id": source["revision_id"], "name": "Working source"}
    derived = op(user, "source.derive_bundle", derived_payload, **options)
    assert op(user, "source.derive_bundle", derived_payload, **options) == derived
    revised_payload = {"bundle_id": source["bundle_id"], "files": files(ORIGINAL)}
    revised = op(
        user, "source.revise_bundle", revised_payload, expected_state=source["state"], **options
    )
    assert (
        op(user, "source.revise_bundle", revised_payload, expected_state=source["state"], **options)
        == revised
    )
    recipe = build_tests.recipe.__wrapped__(settings)
    recipe["outputs"][0]["rights"] = "synthetic-original"
    build_payload = {
        "workspace_id": workspace,
        "project_id": project,
        "source_revision_id": source["revision_id"],
        "recipe_id": recipe["id"],
    }
    build = op(user, "build.request", build_payload, **options)
    cancellation = {"build_id": build["build_id"]}
    cancelled = op(
        user, "build.cancel", cancellation, expected_state=build["state_token"], **options
    )
    assert (
        op(user, "build.cancel", cancellation, expected_state=build["state_token"], **options)
        == cancelled
    )
    assert IdempotencyRecord.objects.count() == 4
    assert set(IdempotencyRecord.objects.values_list("scope", flat=True)) == {
        f"workspace:{workspace}"
    }


def test_operator_credential_scope_does_not_add_workspace_membership_requirement(
    users, workspace, project, settings
):
    from specmate.access.models import Installation

    from . import test_builds as build_tests

    user = users["owner"]
    Installation.objects.create(owner=user)
    recipe = build_tests.recipe.__wrapped__(settings)
    ctx = replace(keyed_context(user), idempotency_key=None)
    credential = execute(
        "runner.enroll",
        ctx,
        {
            "workspace_id": workspace_of(project),
            "name": "Scoped credential",
            "recipe_ids": [recipe["id"]],
        },
    ).result
    WorkspaceMember.objects.filter(workspace_id=workspace, user=user).delete()
    ctx = replace(ctx, idempotency_key="revoke-key")
    result = execute("runner.revoke", ctx, {"credential_id": credential["credential_id"]})
    assert (
        execute("runner.revoke", ctx, {"credential_id": credential["credential_id"]}).result
        == result.result
    )
    assert IdempotencyRecord.objects.get().scope == f"workspace:{workspace}"
