"""FND-006: keys isolate authorized projects and retain exact old outcomes safely."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier
from uuid import uuid4

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.access.models import Membership, Project
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
from specmate.operations.scope import project_scope, revision_scope

from .conftest import op
from .test_transports import api, post_op


def payload(project, name="Synthetic component"):
    return {"project_id": project, "kind": "part", "name": name}


def keyed_context(user, key="same-key"):
    return Context(user=user, via="internal", request_id="scope-test", idempotency_key=key)


@pytest.mark.parametrize("via", ["api", "job"])
def test_same_actor_operation_key_is_independent_per_project(users, project, via):
    user = users["owner"]
    other = op(user, "project.create", {"name": "Other synthetic scope"})["project_id"]

    def create(project_id):
        if via == "api":
            response = post_op(
                api(user), "definition.create", payload(project_id), idempotency_key="same-key"
            )
            assert response.status_code == 200
            return response.json()["result"]
        return op(user, "definition.create", payload(project_id), idempotency_key="same-key")

    a, b = create(project), create(other)
    assert a["definition_id"] != b["definition_id"]
    assert create(project) == a and create(other) == b
    assert set(IdempotencyRecord.objects.values_list("scope", flat=True)) == {
        f"project:{project}",
        f"project:{other}",
    }
    assert Definition.objects.count() == 2


def test_same_project_changed_payload_still_mismatches(users, project):
    user = users["owner"]
    execute("definition.create", keyed_context(user), payload(project))
    with pytest.raises(IdempotencyMismatch):
        execute("definition.create", keyed_context(user), payload(project, "Different"))
    assert Definition.objects.count() == 1


def test_revoked_scope_is_checked_before_cached_fingerprint_or_result(users, project):
    user = users["owner"]
    execute("definition.create", keyed_context(user), payload(project))
    Membership.objects.filter(project_id=project, user=user).delete()
    client = api(user)
    exact = post_op(client, "definition.create", payload(project), idempotency_key="same-key")
    changed = post_op(
        client, "definition.create", payload(project, "Changed"), idempotency_key="same-key"
    )
    absent = post_op(client, "definition.create", payload(str(uuid4())), idempotency_key="same-key")
    assert exact.status_code == changed.status_code == absent.status_code == 404
    assert exact.json() == changed.json() == absent.json()
    assert IdempotencyRecord.objects.count() == 1


def test_top_level_project_creation_has_global_namespace(users):
    user = users["owner"]
    ctx = keyed_context(user)
    first = execute("project.create", ctx, {"name": "Global keyed project"})
    again = execute("project.create", ctx, {"name": "Global keyed project"})
    assert again.replayed and first.result == again.result
    assert IdempotencyRecord.objects.get().scope == "global"
    assert Project.objects.count() == 1


def test_missing_or_invalid_scope_hook_fails_before_effect(users, project, monkeypatch):
    original = registry["definition.create"]
    name = "extension.create"
    for hook in (None, lambda ctx, parsed: "legacy", lambda ctx, parsed: "project:not-a-uuid"):
        monkeypatch.setitem(registry, name, replace(original, name=name, idempotency_scope=hook))
        with pytest.raises(PermissionDenied, match="scope policy"):
            execute(name, keyed_context(users["owner"]), payload(project))
    assert not Definition.objects.exists()
    assert not IdempotencyRecord.objects.exists()


def test_explicit_domain_scope_hook_uses_authorized_project(users, project, monkeypatch):
    original = registry["definition.create"]
    name = "extension.create"
    monkeypatch.setitem(
        registry,
        name,
        replace(
            original,
            name=name,
            idempotency_scope=lambda ctx, parsed: project_scope(ctx, parsed.project_id),
            authorize_replay=lambda ctx, parsed, stored: project_scope(ctx, parsed.project_id),
        ),
    )
    ctx = keyed_context(users["owner"])
    first = execute(name, ctx, payload(project))
    assert execute(name, ctx, payload(project)).result == first.result
    assert IdempotencyRecord.objects.get().scope == f"project:{project}"


def test_revision_scope_helper_resolves_owner_and_rechecks_membership(users, project, definition):
    frozen = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": definition["draft_id"]},
        expected_state=definition["state"],
    )
    assert (
        revision_scope(keyed_context(users["viewer"]), frozen["revision_id"])
        == f"project:{project}"
    )
    with pytest.raises(NotFound):
        revision_scope(keyed_context(users["outsider"]), frozen["revision_id"])


def make_legacy(user, project):
    ctx = keyed_context(user)
    result = execute("definition.create", ctx, payload(project)).result
    IdempotencyRecord.objects.update(scope="legacy")
    return ctx, result


def test_legacy_exact_replay_is_adopted_without_rerunning_handler(users, project, monkeypatch):
    user = users["owner"]
    ctx, result = make_legacy(user, project)

    def forbidden_handler(ctx, parsed):
        pytest.fail("A retained effect must not execute again.")

    monkeypatch.setitem(
        registry,
        "definition.create",
        replace(registry["definition.create"], handler=forbidden_handler),
    )
    replay = execute("definition.create", ctx, payload(project))
    assert replay.replayed and replay.result == result
    assert IdempotencyRecord.objects.get().scope == f"project:{project}"
    assert Definition.objects.count() == 1


def test_legacy_adoption_rechecks_current_authority(users, project):
    user = users["editor"]
    ctx, _ = make_legacy(user, project)
    Membership.objects.filter(project_id=project, user=user).update(role="viewer")
    with pytest.raises(PermissionDenied):
        execute("definition.create", ctx, payload(project))
    assert IdempotencyRecord.objects.get().scope == "legacy"
    assert Definition.objects.count() == 1


def test_unresolved_legacy_key_cannot_repeat_effect_with_changed_payload(users, project):
    user = users["owner"]
    ctx, _ = make_legacy(user, project)
    other = op(user, "project.create", {"name": "New project"})["project_id"]
    for new_payload in (payload(project, "Changed"), payload(other)):
        with pytest.raises(Conflict, match="legacy outcome"):
            execute("definition.create", ctx, new_payload)
    assert Definition.objects.count() == 1
    # Once the original exact request has been authorized and adopted, reuse in
    # another scope is independent without discarding the old outcome.
    execute("definition.create", ctx, payload(project))
    execute("definition.create", ctx, payload(other))
    assert Definition.objects.count() == 2


@pytest.mark.parametrize("same_project", [True, False])
@pytest.mark.django_db(transaction=True)
def test_concurrent_keys_preserve_per_project_effects(users, project, monkeypatch, same_project):
    user = users["owner"]
    other = (
        project
        if same_project
        else op(user, "project.create", {"name": "Parallel project"})["project_id"]
    )
    barrier = Barrier(2)
    original = registry["definition.create"]

    def synchronized_handler(ctx, parsed):
        barrier.wait(timeout=10)
        return original.handler(ctx, parsed)

    monkeypatch.setitem(
        registry, "definition.create", replace(original, handler=synchronized_handler)
    )

    def create(project_id):
        try:
            try:
                return execute("definition.create", keyed_context(user), payload(project_id)).result
            except Conflict:
                return None
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, [project, other]))
    expected = 1 if same_project else 2
    assert sum(result is not None for result in results) == expected
    assert Definition.objects.count() == IdempotencyRecord.objects.count() == expected


def test_database_rejects_invalid_namespace(users):
    with pytest.raises(DatabaseError), transaction.atomic():
        IdempotencyRecord.objects.create(
            actor=users["owner"],
            scope="",
            operation="example",
            key="key",
            fingerprint="0" * 64,
            result={},
        )


@pytest.mark.django_db(transaction=True)
def test_migration_retains_unscoped_outcome_then_adopts_exact_replay(users, project):
    from django.db.migrations.executor import MigrationExecutor

    user = users["owner"]
    ctx = keyed_context(user)
    result = execute("definition.create", ctx, payload(project)).result
    executor = MigrationExecutor(connection)
    old_target = [("operations", "0002_immutable_rows")]
    new_target = [("operations", "0003_idempotency_scope")]
    try:
        executor.migrate(old_target)
        old_apps = executor.loader.project_state(old_target).apps
        old_record = old_apps.get_model("operations", "IdempotencyRecord").objects.get()
        assert old_record.result == result
    finally:
        MigrationExecutor(connection).migrate(new_target)
    retained = IdempotencyRecord.objects.get()
    assert retained.scope == "legacy" and retained.result == result
    replay = execute("definition.create", ctx, payload(project))
    assert replay.replayed and replay.result == result
    retained.refresh_from_db()
    assert retained.scope == f"project:{project}"
    assert Definition.objects.count() == 1


def test_derived_source_and_build_targets_use_their_owning_project(users, project, settings):
    from . import test_builds as build_tests
    from .test_sources import ORIGINAL, files, register

    user = users["owner"]
    register(user, project, ORIGINAL)
    source = op(
        user,
        "source.create_original_bundle",
        {
            "project_id": project,
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
    assert set(IdempotencyRecord.objects.values_list("scope", flat=True)) == {f"project:{project}"}


def test_operator_credential_scope_does_not_add_project_membership_requirement(
    users, project, settings
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
            "project_id": project,
            "name": "Scoped credential",
            "recipe_ids": [recipe["id"]],
        },
    ).result
    Membership.objects.filter(project_id=project, user=user).delete()
    ctx = replace(ctx, idempotency_key="revoke-key")
    result = execute("runner.revoke", ctx, {"credential_id": credential["credential_id"]})
    assert (
        execute("runner.revoke", ctx, {"credential_id": credential["credential_id"]}).result
        == result.result
    )
    assert IdempotencyRecord.objects.get().scope == f"project:{project}"
