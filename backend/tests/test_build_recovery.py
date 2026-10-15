"""BLD-004: cancellation truthfulness, unresolved-work resolution, retries and history.

Uses the shared operation layer and real PostgreSQL. Runner behavior is simulated through
its API operations; no native tool runs here.
"""
# ruff: noqa: F811  (shared pytest fixtures are imported by name)

import uuid
from datetime import timedelta

import pytest
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from specmate.access.models import WorkspaceMember
from specmate.builds.models import BuildAttempt, BuildOutbox, BuildStage, StageEvent
from specmate.jobs import workflows
from specmate.operations import (
    Conflict,
    Context,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    Unsupported,
    ValidationFailed,
    execute,
)
from specmate.operations.models import IdempotencyRecord

from .conftest import op
from .test_builds import (  # noqa: F401 - shared fixtures
    OUTPUT,
    RIGHTS,
    build,
    build_payload,
    credential,
    digest,
    fence,
    lease,
    output_payload,
    recipe,
    runner_op,
    source,
    success_receipt,
    upload,
)


def token(stage_id) -> str:
    return f"stage-v{BuildStage.objects.get(id=stage_id).version}"


def revoke(users, credential):
    execute(
        "runner.revoke",
        Context(user=users["owner"], via="internal", request_id="revoke"),
        {"credential_id": credential["credential_id"]},
    )


def fail(credential, lease, code=3):
    return runner_op(
        credential,
        "runner.complete",
        {**fence(lease), "outcome": "failed", "exit_code": code, "message": "tool failed"},
    )


def abandon(user, build, **kw):
    stage = BuildStage.objects.get(build_id=build["build_id"])
    return op(
        user,
        "build.abandon",
        {"build_id": build["build_id"], "basis": kw.pop("basis", "Runner host retired.")},
        expected_state=kw.pop("expected_state", f"stage-v{stage.version}"),
        idempotency_key=kw.pop("key", "abandon-1"),
    )


def retry(user, build, key="retry-1", **kw):
    stage = BuildStage.objects.get(build_id=build["build_id"])
    return op(
        user,
        "build.retry",
        {"build_id": build["build_id"]},
        expected_state=kw.pop("expected_state", f"stage-v{stage.version}"),
        idempotency_key=key,
    )


# --- a receipt can never claim cancellation nobody asked for -----------------------------


def test_cancelled_receipt_requires_a_prior_cancellation_request(credential, lease):
    with pytest.raises(ValidationFailed):
        runner_op(credential, "runner.complete", {**fence(lease), "outcome": "cancelled"})
    stage = BuildStage.objects.get(id=lease["stage_id"])
    assert stage.state == "leased" and stage.receipt is None


def test_database_refuses_cancelled_stage_without_request(build):
    with pytest.raises(IntegrityError), transaction.atomic():
        BuildStage.objects.filter(build_id=build["build_id"]).update(
            state="cancelled", receipt={"outcome": "cancelled"}
        )


def test_cancel_then_runner_failure_is_retained_as_failure(users, build, credential, lease):
    cancelled = op(
        users["owner"],
        "build.cancel",
        {"build_id": build["build_id"]},
        expected_state=token(lease["stage_id"]),
    )
    assert cancelled["state"] == "cancellation_requested"
    assert fail(credential, lease, 9)["state"] == "failed"
    stage = BuildStage.objects.get(id=lease["stage_id"])
    assert stage.receipt["exit_code"] == 9 and stage.cancellation_requested_at is not None


# --- abandon ------------------------------------------------------------------------------


def test_abandon_is_refused_while_the_runner_can_still_reconcile(users, build, credential, lease):
    runner_op(credential, "runner.heartbeat", fence(lease))
    with pytest.raises(Conflict):
        abandon(users["owner"], build)
    assert BuildStage.objects.get(id=lease["stage_id"]).state == "running"


def test_abandon_after_revocation_records_unconfirmed_failure_never_cancelled(
    users, build, credential, lease
):
    runner_op(credential, "runner.heartbeat", fence(lease))
    upload(credential, lease)
    revoke(users, credential)
    stage = BuildStage.objects.get(id=lease["stage_id"])
    assert stage.state == "cancellation_requested"  # revocation requests, never confirms
    result = abandon(users["owner"], build)
    assert result["state"] == "failed"
    receipt = result["receipt"]
    assert receipt["resolution"] == "abandoned_unreconciled"
    assert receipt["termination_confirmed"] is False
    assert receipt["cancellation_requested"] is True
    assert receipt["outputs"] == [{"path": "result.txt", "sha256": digest(OUTPUT)}]
    assert receipt["basis"] == "Runner host retired."
    # People are shown by username, never by internal primary key.
    assert receipt["resolved_by"] == users["owner"].username
    for read in ("build.get", "build.history"):
        shown = op(users["viewer"], read, {"build_id": build["build_id"]})["receipt"]
        assert shown["resolved_by"] == users["owner"].username
    events = list(StageEvent.objects.filter(stage_id=lease["stage_id"]).order_by("id"))
    assert events[-1].kind == "abandoned"
    # Uploaded bytes are retained but never become an accepted artifact.
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "build.output",
            {
                "build_id": build["build_id"],
                "output_id": str(stage.outputs.get().id),
            },
        )
    # The revoked runner cannot later complete the same stage as a success.
    with pytest.raises((PermissionDenied, Unauthenticated)):
        runner_op(credential, "runner.complete", success_receipt(lease))
    assert BuildStage.objects.get(id=lease["stage_id"]).state == "failed"


def test_abandon_interrupted_without_cancellation_by_expired_credential(
    users, build, credential, lease
):
    from specmate.builds.models import RunnerCredential

    BuildStage.objects.filter(id=lease["stage_id"]).update(
        lease_expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert (
        op(users["owner"], "build.poll", {"build_id": build["build_id"]})["state"] == "interrupted"
    )
    RunnerCredential.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
    result = abandon(users["owner"], build)
    assert result["receipt"]["cancellation_requested"] is False
    assert result["state"] == "failed"


def test_abandon_authority_cas_validation_and_scope(users, workspace, build, credential, lease):
    revoke(users, credential)
    with pytest.raises(PermissionDenied):
        abandon(users["viewer"], build)
    with pytest.raises(NotFound):
        abandon(users["outsider"], build)
    with pytest.raises(Conflict):
        abandon(users["owner"], build, expected_state="stage-v1")
    with pytest.raises(ValidationFailed):
        abandon(users["owner"], build, basis="   ")
    assert BuildStage.objects.get(id=lease["stage_id"]).receipt is None
    # An executing member who is not the requester may resolve it.
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="admin"
    )
    assert abandon(users["editor"], build)["state"] == "failed"


def test_abandon_idempotent_replay_mismatch_and_terminal_conflict(users, build, credential, lease):
    revoke(users, credential)
    first = abandon(users["owner"], build)
    stage = BuildStage.objects.get(id=lease["stage_id"])
    replay = op(
        users["owner"],
        "build.abandon",
        {"build_id": build["build_id"], "basis": "Runner host retired."},
        expected_state="stage-v" + str(stage.version - 1),
        idempotency_key="abandon-1",
    )
    assert replay == first
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "build.abandon",
            {"build_id": build["build_id"], "basis": "Different reason."},
            expected_state="stage-v" + str(stage.version - 1),
            idempotency_key="abandon-1",
        )
    with pytest.raises(Conflict):
        abandon(users["owner"], build, key="abandon-2", expected_state=f"stage-v{stage.version}")
    assert StageEvent.objects.filter(stage=stage, kind="abandoned").count() == 1


def test_abandon_replay_rechecks_current_authority(users, workspace, build, credential, lease):
    revoke(users, credential)
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="admin"
    )
    first = abandon(users["editor"], build)
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).delete()
    stage = BuildStage.objects.get(id=lease["stage_id"])
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "build.abandon",
            {"build_id": build["build_id"], "basis": "Runner host retired."},
            expected_state=f"stage-v{stage.version - 1}",
            idempotency_key="abandon-1",
        )
    assert first["state"] == "failed"


def test_never_leased_work_is_cancelled_not_abandoned(users, build):
    with pytest.raises(Conflict):
        abandon(users["owner"], build)
    assert BuildStage.objects.get(build_id=build["build_id"]).state == "waiting_dispatch"


# --- retry --------------------------------------------------------------------------------


def failed_build(users, build, credential, lease):
    runner_op(credential, "runner.heartbeat", fence(lease))
    fail(credential, lease)
    return build


def test_retry_creates_a_new_attempt_over_the_exact_inputs(users, build, credential, lease):
    failed_build(users, build, credential, lease)
    before = BuildStage.objects.get(id=lease["stage_id"])
    receipt = dict(before.receipt)
    result = retry(users["owner"], build)
    assert result["build_id"] != build["build_id"]
    assert result["workflow_id"] != build["workflow_id"]
    assert result["retry_of"] == build["build_id"]
    assert result["state"] == "waiting_dispatch"
    old, new = (BuildAttempt.objects.get(id=i) for i in (build["build_id"], result["build_id"]))
    assert new.retry_of_id == old.id
    assert (new.source_revision_id, new.recipe_id, new.recipe) == (
        old.source_revision_id,
        old.recipe_id,
        old.recipe,
    )
    assert BuildOutbox.objects.filter(build=new, delivered_at__isnull=True).exists()
    after = BuildStage.objects.get(id=lease["stage_id"])
    assert (after.state, after.receipt, after.version) == ("failed", receipt, before.version)
    assert (
        StageEvent.objects.filter(stage__build=new, kind="requested").get().detail["retry_of"]
        == build["build_id"]
    )


def test_retry_follows_cancelled_and_abandoned_attempts(users, build, credential, lease):
    revoke(users, credential)
    abandoned = abandon(users["owner"], build)
    assert abandoned["state"] == "failed"
    second = retry(users["owner"], build)
    # The new attempt can itself be cancelled and then retried: a chain, one link each.
    op(
        users["owner"],
        "build.cancel",
        {"build_id": second["build_id"]},
        expected_state=second["state_token"],
    )
    stage = BuildStage.objects.get(build_id=second["build_id"])
    assert stage.state == "cancelled"
    third = retry(users["owner"], second, key="retry-2")
    assert third["retry_of"] == second["build_id"]


def test_retry_refuses_success_active_stale_and_second_retry(users, build, credential, lease):
    with pytest.raises(Conflict):  # still active
        retry(users["owner"], build)
    upload(credential, lease)
    runner_op(credential, "runner.complete", success_receipt(lease))
    with pytest.raises(ValidationFailed):
        retry(users["owner"], build)
    assert BuildAttempt.objects.count() == 1


def test_second_retry_reports_the_first_and_creates_nothing(users, build, credential, lease):
    failed_build(users, build, credential, lease)
    first = retry(users["owner"], build)
    with pytest.raises(Conflict) as exc:
        retry(users["owner"], build, key="retry-other")
    assert exc.value.details["retry_build_id"] == first["build_id"]
    assert BuildAttempt.objects.count() == 2


def test_retry_cas_authority_key_and_scope(users, build, credential, lease):
    failed_build(users, build, credential, lease)
    with pytest.raises(Conflict):
        retry(users["owner"], build, expected_state="stage-v1")
    with pytest.raises(PermissionDenied):
        retry(users["editor"], build)
    with pytest.raises(PermissionDenied):
        retry(users["viewer"], build)
    with pytest.raises(NotFound):
        retry(users["outsider"], build)
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "build.retry",
            {"build_id": build["build_id"]},
            expected_state=token(lease["stage_id"]),
        )
    assert BuildAttempt.objects.count() == 1


def test_retry_replay_returns_same_attempt_and_checks_current_authority(
    users, workspace, build, credential, lease
):
    failed_build(users, build, credential, lease)
    first = retry(users["owner"], build)
    assert retry(users["owner"], build) == first
    assert BuildAttempt.objects.count() == 2
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "build.retry",
            {"build_id": build["build_id"]},
            expected_state="stage-v1",
            idempotency_key="retry-1",
        )
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["owner"]).update(
        role="viewer"
    )
    with pytest.raises(PermissionDenied):
        retry(users["owner"], build)


def test_retry_refuses_changed_recipe_approval(users, build, credential, lease, settings):
    failed_build(users, build, credential, lease)
    changed = {**settings.SPECMATE_APPROVED_RECIPES["synthetic-check-r1"]}
    changed["limits"] = {**changed["limits"], "timeout_seconds": 61}
    settings.SPECMATE_APPROVED_RECIPES = {"synthetic-check-r1": changed}
    with pytest.raises(Conflict):
        retry(users["owner"], build)
    settings.SPECMATE_APPROVED_RECIPES = {}
    with pytest.raises(Unsupported):
        retry(users["owner"], build, key="retry-gone")
    assert BuildAttempt.objects.count() == 1


def test_retry_cannot_bypass_compiler_consent_hook(users, build, credential, lease, monkeypatch):
    failed_build(users, build, credential, lease)

    def deny(ctx, p, recipe):
        raise PermissionDenied("Use firmware_build.request with explicit source-execution consent.")

    monkeypatch.setattr("specmate.firmware_builds.operations.authorize_request", deny)
    with pytest.raises(PermissionDenied):
        retry(users["owner"], build)
    assert BuildAttempt.objects.count() == 1


def test_retry_rollback_leaves_no_attempt_stage_outbox_or_key(
    users, build, credential, lease, monkeypatch
):
    failed_build(users, build, credential, lease)

    def boom(*a, **k):
        raise DatabaseError("synthetic outbox failure")

    monkeypatch.setattr(BuildOutbox.objects, "create", boom)
    with pytest.raises(DatabaseError):
        retry(users["owner"], build)
    assert BuildAttempt.objects.count() == BuildStage.objects.count() == 1
    assert not IdempotencyRecord.objects.filter(operation="build.retry").exists()


def test_database_refuses_self_and_duplicate_retry_links(users, build, credential, lease):
    failed_build(users, build, credential, lease)
    new = retry(users["owner"], build)
    original = BuildAttempt.objects.get(id=build["build_id"])
    own = uuid.uuid4()
    with pytest.raises(IntegrityError), transaction.atomic():
        BuildAttempt.objects.create(
            id=own,
            workspace_id=original.workspace_id,
            requested_by=original.requested_by,
            source_revision=original.source_revision,
            recipe_id=original.recipe_id,
            recipe=original.recipe,
            workflow_id=f"specmate-build-{own}",
            retry_of_id=own,
        )
    with pytest.raises(IntegrityError), transaction.atomic():
        BuildAttempt.objects.create(
            workspace_id=original.workspace_id,
            requested_by=original.requested_by,
            source_revision=original.source_revision,
            recipe_id=original.recipe_id,
            recipe=original.recipe,
            workflow_id=f"specmate-build-{uuid.uuid4()}",
            retry_of=original,
        )
    assert new["retry_of"] == build["build_id"]


# --- history and listing ------------------------------------------------------------------


def test_history_retains_events_partial_outputs_and_lineage_without_secrets(
    users, build, credential, lease
):
    runner_op(credential, "runner.heartbeat", fence(lease))
    upload(credential, lease)
    op(
        users["owner"],
        "build.cancel",
        {"build_id": build["build_id"]},
        expected_state=token(lease["stage_id"]),
    )
    runner_op(
        credential,
        "runner.complete",
        {
            **fence(lease),
            "outcome": "cancelled",
            "outputs": [{"path": "result.txt", "sha256": digest(OUTPUT)}],
        },
    )
    history = op(users["viewer"], "build.history", {"build_id": build["build_id"]})
    assert history["state"] == "cancelled" and history["receipt"]["outcome"] == "cancelled"
    assert history["outputs"] == [
        {
            "path": "result.txt",
            "sha256": digest(OUTPUT),
            "size": len(OUTPUT),
            "rights": RIGHTS,
            "accepted": False,
            # Unaccepted bytes carry no reproducibility level at all.
            "reproducibility": None,
        }
    ]
    kinds = [e["kind"] for e in history["events"]]
    assert kinds[0] == "requested" and "cancellation_requested" in kinds
    assert kinds.index("output_verified") < kinds.index("completed")
    assert history["retry_available"] is True and history["cancel_available"] is False
    flat = str(history["events"])
    assert lease["fencing_token"] not in flat and "runner_id" not in flat
    second = retry(users["owner"], build)
    again = op(users["viewer"], "build.history", {"build_id": build["build_id"]})
    assert again["retried_by"] == second["build_id"] and again["retry_available"] is False
    assert [item["build_id"] for item in again["lineage"]] == [
        build["build_id"],
        second["build_id"],
    ]
    newest = op(users["viewer"], "build.history", {"build_id": second["build_id"]})
    assert newest["retry_of"] == build["build_id"] and newest["lineage"][1]["current"]
    # Only the original requester is flagged; the UI offers cancellation to them without the grant.
    assert newest["requested_by_viewer"] is False
    assert op(users["owner"], "build.history", {"build_id": second["build_id"]})[
        "requested_by_viewer"
    ] is (BuildAttempt.objects.get(id=second["build_id"]).requested_by_id == users["owner"].pk)


def test_history_flags_resolution_actions_for_unavailable_runner(users, build, credential, lease):
    revoke(users, credential)
    pending = op(users["owner"], "build.history", {"build_id": build["build_id"]})
    assert pending["abandon_available"] is True
    assert pending["awaiting_runner_confirmation"] is True
    assert pending["cancel_available"] is False and pending["retry_available"] is False


def test_history_and_list_are_project_scoped(users, build, workspace):
    with pytest.raises(NotFound):
        op(users["outsider"], "build.history", {"build_id": build["build_id"]})
    with pytest.raises(NotFound):
        op(users["outsider"], "build.list", {"workspace_id": workspace})
    listing = op(users["viewer"], "build.list", {"workspace_id": workspace})
    assert [b["build_id"] for b in listing["builds"]] == [build["build_id"]]
    assert listing["builds"][0]["retry_of"] is None and listing["truncated"] is False
    assert listing["builds"][0]["requested_by"] == users["owner"].get_username()
    history = op(users["viewer"], "build.history", {"build_id": build["build_id"]})
    assert history["requested_by"] == users["owner"].get_username()
    assert history["requested_by_viewer"] is False
    with pytest.raises(NotFound):
        op(users["viewer"], "build.history", {"build_id": str(uuid.uuid4())})


def test_list_orders_newest_first_and_excludes_compiler_recipes(
    users, build, credential, lease, workspace
):
    failed_build(users, build, credential, lease)
    second = retry(users["owner"], build)
    with CaptureQueriesContext(connection) as queries:
        listing = op(users["viewer"], "build.list", {"workspace_id": workspace})["builds"]
    # The trusted adapter and operation layer each recheck the actor; no requester read per row.
    assert sum('FROM "auth_user"' in query["sql"] for query in queries) == 2
    assert all(row["requested_by"] == users["owner"].get_username() for row in listing)
    assert [b["build_id"] for b in listing] == [second["build_id"], build["build_id"]]
    assert listing[0]["retry_of"] == build["build_id"]


# --- workflow monitoring ------------------------------------------------------------------


def test_workflow_keeps_monitoring_interrupted_work_until_a_final_receipt():
    assert "interrupted" not in workflows.FINAL
    assert workflows.FINAL == {"succeeded", "failed", "cancelled"}
    assert workflows.poll_delay("interrupted") > workflows.poll_delay("running")
    assert workflows.poll_delay("cancellation_requested") == workflows.poll_delay("running")
