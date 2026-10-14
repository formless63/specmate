"""OPS-005: distinct diagnostics categories, scoped status reads, safe stop and reconcile."""

import hashlib
import io
import json
import os
import uuid
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, transaction
from django.test import Client
from django.utils import timezone

from specmate.access.models import Installation, WorkspaceMember
from specmate.builds.models import BuildStage
from specmate.builds.operations import authenticate_runner
from specmate.diagnostics.guards import InstallationNotAccepting
from specmate.diagnostics.models import WorkControl, WorkControlEvent
from specmate.operations import (
    Conflict,
    Context,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    execute,
)

from .conftest import op

SOURCE = b"synthetic source\n"
RIGHTS = "synthetic-original"


def digest(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def recipe(settings):
    config = {
        "id": "synthetic-check-r1",
        "image": "example.invalid/test@sha256:" + "1" * 64,
        "argv": ["/tool", "/inputs/source.txt", "/outputs/result.txt"],
        "limits": {
            "cpus": 1,
            "memory_bytes": 64 * 1024**2,
            "timeout_seconds": 60,
            "pids": 16,
            "max_output_bytes": 1024,
        },
        "outputs": [{"path": "result.txt", "media_type": "text/plain", "rights": RIGHTS}],
    }
    settings.SPECMATE_APPROVED_RECIPES = {config["id"]: config}
    settings.SPECMATE_LEASE_SECONDS = 60
    return config


def make_source(users, project, content=SOURCE):
    op(
        users["owner"],
        "source.register_blob",
        {
            "project_id": project,
            "sha256": digest(content),
            "size": len(content),
            "media_type": "text/plain",
        },
        attachments={"content": io.BytesIO(content)},
    )
    return op(
        users["owner"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Synthetic input",
            "files": [
                {
                    "path": "source.txt",
                    "sha256": digest(content),
                    "media_type": "text/plain",
                    "rights": RIGHTS,
                }
            ],
        },
    )["revision_id"]


@pytest.fixture
def source(users, project):
    return make_source(users, project)


@pytest.fixture
def request_one(users, project, source, recipe):
    counter = iter(range(1000))

    def make():
        return op(
            users["owner"],
            "build.request",
            {"project_id": project, "source_revision_id": source, "recipe_id": recipe["id"]},
            idempotency_key=f"build-{next(counter)}",
        )

    return make


@pytest.fixture
def build(request_one):
    return request_one()


@pytest.fixture
def operator(users):
    Installation.objects.create(owner=users["owner"])
    return users["owner"]


def internal(user, name, payload=None, **kw):
    return execute(
        name, Context(user=user, via="internal", request_id=str(uuid.uuid4()), **kw), payload or {}
    )


def state_token():
    control = WorkControl.objects.filter(singleton=True).first()
    return f"work-v{control.version if control else 0}"


def stop(operator, mode="drain", reason="maintenance", **kw):
    return internal(
        operator,
        "installation.safe_stop",
        {"mode": mode, "reason": reason},
        expected_state=state_token(),
        **kw,
    ).result


@pytest.fixture
def credential(users, project, recipe, operator):
    return internal(
        operator,
        "runner.enroll",
        {"project_id": project, "name": "Synthetic runner", "recipe_ids": [recipe["id"]]},
    ).result


def runner_op(credential, name, payload=None):
    return execute(
        name,
        Context(user=authenticate_runner(credential["token"]), via="api", request_id="r"),
        payload or {},
    ).result


def status(user, project):
    return op(user, "diagnostics.project_status", {"project_id": project})


def codes(report):
    return {f["code"] for f in report["findings"]}


def lease_one(users, credential, build):
    op(users["owner"], "build.dispatch", {"build_id": build["build_id"]})
    return runner_op(credential, "runner.lease")["lease"]


# ---- scoped project status -------------------------------------------------------------


def test_status_without_runner_names_the_missing_tool_not_a_generic_failure(users, project, build):
    report = status(users["viewer"], project)
    assert report["queue"]["pending"] == 1
    assert report["runner"]["state"] == "not_enrolled"
    assert "no_runner_enrolled" in codes(report)
    finding = next(f for f in report["findings"] if f["code"] == "no_runner_enrolled")
    assert finding["category"] == "tool_unavailable"
    assert "sources" in finding["recovery"].lower()
    assert report["workflow_engine"]["state"] == "not_evaluated"
    # A viewer sees the state but is told, separately, that it cannot execute.
    assert report["can_execute"] is False
    assert "actor_cannot_execute" in codes(report)
    assert status(users["owner"], project)["can_execute"] is True


def test_status_is_scoped_to_readable_projects_without_cross_project_counts(
    users, project, build, recipe
):
    other = op(users["outsider"], "project.create", {"name": "Other bench"})["project_id"]
    report = status(users["outsider"], other)
    assert report["queue"]["pending"] == 0
    assert report["builds"] == []
    assert report["tools"] == []
    assert report["dispatch"]["undelivered"] == 0
    with pytest.raises(NotFound):
        status(users["outsider"], project)
    with pytest.raises(NotFound):
        status(users["outsider"], str(uuid.uuid4()))
    # Operators' installation-wide report is a separate, internal-only operation.
    with pytest.raises(PermissionDenied):
        op(users["owner"], "diagnostics.installation", {})


def test_status_rejects_unknown_fields_and_anonymous_callers(users, project):
    with pytest.raises(ValidationFailed):
        op(users["owner"], "diagnostics.project_status", {"project_id": project, "extra": 1})
    from specmate.operations import Unauthenticated

    with pytest.raises(Unauthenticated):
        execute(
            "diagnostics.project_status",
            Context(user=None, via="api", request_id="r"),
            {"project_id": project},
        )


def test_reading_status_never_changes_work(users, project, build):
    before = list(BuildStage.objects.values_list("id", "state", "version"))
    for _ in range(3):
        status(users["viewer"], project)
    assert list(BuildStage.objects.values_list("id", "state", "version")) == before


def test_unapproved_or_changed_recipe_is_tool_unavailable(users, project, build, settings, recipe):
    settings.SPECMATE_APPROVED_RECIPES = {}
    report = status(users["owner"], project)
    assert {"recipe_not_approved"} <= codes(report)
    assert report["tools"][0]["status"] == "not_approved"
    settings.SPECMATE_APPROVED_RECIPES = {
        recipe["id"]: {**recipe, "limits": {**recipe["limits"], "cpus": 2}}
    }
    report = status(users["owner"], project)
    assert "recipe_changed" in codes(report)
    assert "recipe_not_approved" not in codes(report)


# ---- storage ---------------------------------------------------------------------------


def storage_codes(users, project):
    return codes(status(users["owner"], project))


def test_fresh_storage_is_not_initialized_rather_than_healthy(users, project):
    report = status(users["owner"], project)
    assert report["storage"]["state"] == "not_initialized"
    assert not any(f["category"] == "storage_failure" for f in report["findings"])


def test_storage_root_missing_blob_missing_and_read_only_are_distinct(
    users, project, source, artifact_root
):
    assert status(users["owner"], project)["storage"]["state"] == "available"
    blob = artifact_root / "blobs" / "sha256" / digest(SOURCE)[:2] / digest(SOURCE)[2:4]
    blob_file = blob / digest(SOURCE)
    saved = blob_file.read_bytes()
    blob_file.chmod(0o644)
    blob_file.unlink()
    report = status(users["owner"], project)
    assert "storage_blobs_missing" in codes(report)
    assert report["storage"]["missing"] == 1
    assert "missing_sha256" not in report["storage"]  # hashes are operator evidence
    blob_file.write_bytes(saved + b"x")  # wrong size is also not usable
    assert "storage_blobs_missing" in storage_codes(users, project)
    blob_file.write_bytes(saved)
    assert status(users["owner"], project)["storage"]["state"] == "available"
    if os.geteuid() != 0:
        artifact_root.chmod(0o500)
        try:
            assert "storage_read_only" in storage_codes(users, project)
        finally:
            artifact_root.chmod(0o700)
    os.rename(artifact_root, artifact_root.with_name("moved"))
    report = status(users["owner"], project)
    assert "storage_root_missing" in codes(report)
    finding = next(f for f in report["findings"] if f["category"] == "storage_failure")
    assert "re-upload" in finding["recovery"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file permissions")
def test_storage_permission_failure_is_not_reported_as_missing(
    users, project, source, artifact_root
):
    blobs = artifact_root / "blobs"
    blobs.chmod(0)
    try:
        report = status(users["owner"], project)
    finally:
        blobs.chmod(0o700)
    assert "storage_root_permission" in codes(report)
    assert "storage_root_missing" not in codes(report)


def test_low_space_is_reported_with_its_own_recovery(users, project, source, settings):
    settings.SPECMATE_MIN_FREE_BYTES = 1 << 62
    assert "storage_low_space" in storage_codes(users, project)


# ---- permission denial and stale evidence -----------------------------------------------


def test_withdrawn_authority_and_revoked_runner_are_permission_denials(
    users, project, build, credential, operator
):
    lease = lease_one(users, credential, build)
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["owner"]).update(
        role="viewer"
    )
    runner_op(credential, "runner.heartbeat", {**_fence(lease)})
    report = status(users["editor"], project)
    assert "execution_authority_withdrawn" in codes(report)
    denial = next(f for f in report["findings"] if f["code"] == "execution_authority_withdrawn")
    assert denial["category"] == "permission_denied"
    assert denial["evidence"]["build_ids"] == [build["build_id"]]
    assert "no_runner_enrolled" not in codes(report)


def test_revoked_credential_with_waiting_work_is_permission_denied_not_tool_missing(
    users, project, build, credential, operator
):
    internal(operator, "runner.revoke", {"credential_id": credential["credential_id"]})
    report = status(users["owner"], project)
    assert report["runner"]["state"] == "credential_unusable"
    assert "runner_credential_unusable" in codes(report)
    assert "no_runner_enrolled" not in codes(report)


def _fence(lease):
    return {"stage_id": lease["stage_id"], "fencing_token": lease["fencing_token"]}


def test_expired_lease_is_stale_evidence_and_reconcile_never_fabricates(
    users, project, build, credential, operator
):
    lease = lease_one(users, credential, build)
    runner_op(credential, "runner.heartbeat", _fence(lease))
    BuildStage.objects.update(lease_expires_at=timezone.now() - timedelta(seconds=5))
    report = status(users["viewer"], project)
    assert "lease_expired_unreconciled" in codes(report)
    assert report["builds"][0]["lease_expired"] is True
    assert report["runner"]["state"] == "lease_expired"
    result = internal(operator, "installation.reconcile").result
    assert result["newly_interrupted"] == [build["build_id"]]
    assert result["requeued"] == 0
    stage = BuildStage.objects.get()
    assert stage.state == "interrupted" and stage.receipt is None
    report = status(users["viewer"], project)
    assert "interrupted_awaiting_reconciliation" in codes(report)
    assert "lease_expired_unreconciled" not in codes(report)
    again = internal(operator, "installation.reconcile").result
    assert again["newly_interrupted"] == []
    assert again["awaiting_runner_reconciliation"] == [build["build_id"]]
    # Only the owning runner can resume the same execution.
    resumed = runner_op(
        credential,
        "runner.reconcile",
        {**_fence(lease), "container_id": "c1", "observed": "running"},
    )
    assert resumed["state"] == "running"


def test_reconcile_requires_operator_authority(users, build, operator):
    with pytest.raises(PermissionDenied):
        op(users["owner"], "installation.reconcile", {})
    with pytest.raises(PermissionDenied):
        internal(users["editor"], "installation.reconcile")


def test_undelivered_dispatch_is_its_own_category(users, project, build):
    from specmate.builds.models import BuildOutbox

    BuildOutbox.objects.update(last_error="ConnectError")
    report = status(users["owner"], project)
    finding = next(f for f in report["findings"] if f["code"] == "dispatch_undelivered")
    assert finding["category"] == "dispatch_stalled"
    assert finding["evidence"]["error_codes"] == ["ConnectError"]
    assert "saved" in finding["recovery"]


# ---- safe stop -------------------------------------------------------------------------


def test_drain_refuses_new_requests_but_lets_accepted_work_finish(
    users, project, source, recipe, build, credential, operator
):
    result = stop(operator, "drain")
    assert result["mode"] == "draining" and result["quiescent"] is False
    assert result["open_work"] == {"waiting_dispatch": 1}
    with pytest.raises(InstallationNotAccepting) as refused:
        op(
            users["owner"],
            "build.request",
            {"project_id": project, "source_revision_id": source, "recipe_id": recipe["id"]},
            idempotency_key="after-drain",
        )
    assert refused.value.http_status == 503
    assert BuildStage.objects.count() == 1
    report = status(users["viewer"], project)
    assert "installation_draining" in codes(report)
    assert report["work"]["accepting_new_work"] is False
    # The accepted build can still be dispatched, leased and completed.
    lease = lease_one(users, credential, build)
    assert lease is not None
    # A replay of the original accepted request is not a new admission.
    replay = execute(
        "build.request",
        Context(
            user=users["owner"],
            via="job",
            request_id="again",
            idempotency_key="build-0",
        ),
        {"project_id": project, "source_revision_id": source, "recipe_id": recipe["id"]},
    )
    assert replay.replayed is True


def test_interrupt_cancels_unstarted_asks_active_to_stop_and_never_marks_them_done(
    users, project, request_one, credential, operator
):
    running = request_one()
    lease = lease_one(users, credential, running)
    runner_op(credential, "runner.heartbeat", _fence(lease))
    waiting = request_one()
    queued = request_one()
    op(users["owner"], "build.dispatch", {"build_id": queued["build_id"]})
    result = stop(operator, "interrupt", "host maintenance")
    assert result["cancelled_before_start"] == 2
    assert result["cancellation_requested"] == 1
    assert result["quiescent"] is False
    states = {str(s.build_id): s for s in BuildStage.objects.all()}
    for build in (waiting, queued):
        stage = states[build["build_id"]]
        assert stage.state == "cancelled"
        assert stage.receipt["execution_started"] is False
    active = states[running["build_id"]]
    assert active.state == "cancellation_requested" and active.receipt is None
    # No new leases while interrupting; the active runner still sees its cancellation.
    assert runner_op(credential, "runner.lease")["lease"]["cancellation_requested"] is True
    report = status(users["viewer"], project)
    assert "installation_interrupting" in codes(report)
    # The runner confirms termination; only then is the installation quiescent.
    runner_op(credential, "runner.complete", {**_fence(lease), "outcome": "cancelled"})
    assert BuildStage.objects.get(build_id=running["build_id"]).state == "cancelled"
    assert internal(operator, "diagnostics.installation").result["work"]["mode"] == "interrupting"
    again = internal(
        operator,
        "installation.safe_stop",
        {"mode": "interrupt", "reason": "host maintenance"},
        expected_state=state_token(),
    ).result
    assert again["quiescent"] is True and again["open_work"] == {}


def test_interrupted_active_work_with_dead_runner_becomes_interrupted_not_cancelled(
    users, build, credential, operator
):
    lease_one(users, credential, build)
    stop(operator, "interrupt")
    BuildStage.objects.update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    result = internal(operator, "installation.reconcile").result
    assert result["newly_interrupted"] == [build["build_id"]]
    stage = BuildStage.objects.get()
    assert stage.state == "interrupted" and stage.receipt is None
    assert stage.cancellation_requested_at is not None
    # Unreconciled stages keep the installation from being called quiescent.
    again = stop(operator, "interrupt")
    assert again["quiescent"] is False and again["left_unchanged"] == 1


def test_safe_stop_conflicts_stale_token_and_cannot_relax_interrupt(users, operator, build):
    with pytest.raises(Conflict):
        internal(
            operator,
            "installation.safe_stop",
            {"mode": "drain", "reason": "x"},
            expected_state="work-v99",
        )
    with pytest.raises(ValidationFailed):
        internal(operator, "installation.safe_stop", {"mode": "drain", "reason": "x"})
    stop(operator, "interrupt")
    with pytest.raises(Conflict):
        stop(operator, "drain")
    assert WorkControl.objects.get().mode == "interrupting"
    # Escalation from drain is allowed.
    resume_token = state_token()
    internal(operator, "installation.resume", expected_state=resume_token)
    stop(operator, "drain")
    assert stop(operator, "interrupt")["previous_mode"] == "draining"


def test_safe_stop_requires_operator_authority_and_valid_payload(users, operator):
    for actor, via in ((users["owner"], "job"), (users["editor"], "internal")):
        with pytest.raises(PermissionDenied):
            execute(
                "installation.safe_stop",
                Context(user=actor, via=via, request_id="r", expected_state="work-v0"),
                {"mode": "drain", "reason": "x"},
            )
    for payload in (
        {"mode": "halt", "reason": "x"},
        {"mode": "drain", "reason": ""},
        {"mode": "drain", "reason": "x" * 201},
        {"mode": "drain", "reason": "x", "extra": 1},
    ):
        with pytest.raises(ValidationFailed):
            internal(operator, "installation.safe_stop", payload, expected_state="work-v0")
    assert not WorkControl.objects.filter(mode__in=["draining", "interrupting"]).exists()


def test_safe_stop_idempotent_replay_and_mismatch(users, operator, build):
    kw = {"idempotency_key": "stop-1"}
    first = stop(operator, "interrupt", **kw)
    token = state_token()
    replay = internal(
        operator,
        "installation.safe_stop",
        {"mode": "interrupt", "reason": "maintenance"},
        expected_state="work-v0",
        **kw,
    )
    assert replay.replayed is True and replay.result == first
    assert state_token() == token
    assert WorkControlEvent.objects.count() == 1
    with pytest.raises(IdempotencyMismatch):
        internal(
            operator,
            "installation.safe_stop",
            {"mode": "drain", "reason": "maintenance"},
            expected_state="work-v0",
            **kw,
        )
    # A replay is re-authorized: a deposed operator cannot read the retained outcome.
    Installation.objects.update(owner=users["editor"])
    with pytest.raises(PermissionDenied):
        internal(
            operator,
            "installation.safe_stop",
            {"mode": "interrupt", "reason": "maintenance"},
            expected_state="work-v0",
            **kw,
        )


def test_failed_interrupt_rolls_back_every_change(users, operator, build, credential):
    lease_one(users, credential, build)
    with patch("specmate.diagnostics.operations._cancel", side_effect=RuntimeError("boom")):
        with pytest.raises(RuntimeError):
            stop(operator, "interrupt")
    assert state_token() == "work-v0"
    assert WorkControlEvent.objects.count() == 0
    assert BuildStage.objects.get().state == "leased"
    assert not WorkControl.objects.exists()


def test_resume_accepts_work_again_without_restarting_cancelled_work(
    users, project, source, recipe, operator, build
):
    stop(operator, "interrupt")
    assert BuildStage.objects.get().state == "cancelled"
    resumed = internal(operator, "installation.resume", expected_state=state_token()).result
    assert resumed["mode"] == "running" and resumed["previous_mode"] == "interrupting"
    assert BuildStage.objects.get().state == "cancelled"
    new = op(
        users["owner"],
        "build.request",
        {"project_id": project, "source_revision_id": source, "recipe_id": recipe["id"]},
        idempotency_key="after-resume",
    )
    assert new["state"] == "waiting_dispatch"
    with pytest.raises(Conflict):
        internal(operator, "installation.resume", expected_state="work-v1")
    with pytest.raises(PermissionDenied):
        op(users["owner"], "installation.resume", {}, expected_state=state_token())


def test_database_protects_work_history_and_control(operator):
    stop(operator, "drain")
    for mutation in (
        lambda: WorkControlEvent.objects.update(reason="rewritten"),
        lambda: WorkControlEvent.objects.all().delete(),
        lambda: WorkControl.objects.update(version=0),
        lambda: WorkControl.objects.all().delete(),
        lambda: WorkControl.objects.update(mode="stopped"),
        lambda: WorkControl.objects.update(changed_by=None),
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            mutation()


def test_closing_a_browser_does_not_cancel_work(users, project, build, credential):
    client = Client()
    client.force_login(users["owner"])
    assert client.get(f"/api/v0/diagnostics/projects/{project}/status").status_code == 200
    client.logout()
    stage = BuildStage.objects.get()
    assert stage.state == "waiting_dispatch" and stage.cancellation_requested_at is None


# ---- transports ------------------------------------------------------------------------


def test_status_api_is_session_scoped_private_and_matches_the_operation(users, project, build):
    client = Client()
    anonymous = client.get(f"/api/v0/diagnostics/projects/{project}/status")
    assert anonymous.status_code == 401
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/diagnostics/projects/{project}/status").status_code == 404
    client.force_login(users["viewer"])
    response = client.get(f"/api/v0/diagnostics/projects/{project}/status")
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    body = response.json()
    assert body["project_id"] == project and body["queue"]["pending"] == 1
    generic = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "diagnostics.project_status",
                "request_id": "r1",
                "payload": {"project_id": project},
            }
        ),
        content_type="application/json",
    )
    assert generic.status_code == 200
    # Installation-wide operator reads are not available to a session.
    operator_read = client.post(
        "/api/v0/operations",
        data=json.dumps({"operation": "diagnostics.installation", "request_id": "r2"}),
        content_type="application/json",
    )
    assert operator_read.status_code == 403


def test_work_control_command_round_trips_through_the_operation_layer(
    users, operator, build, project
):
    def run(*args):
        out = StringIO()
        call_command("work_control", *args, stdout=out)
        return json.loads(out.getvalue())

    report = run("diagnose")
    assert report["schema"]["ready"] is True and report["work"]["mode"] == "running"
    assert report["workflow_engine"]["state"] == "not_evaluated"
    assert {c["usable"] for c in report["credentials"]} == set()
    assert run("drain", "--reason", "upgrade")["mode"] == "draining"
    assert run("diagnose")["work"]["reason"] == "upgrade"
    assert run("interrupt")["cancelled_before_start"] == 1
    assert run("reconcile")["requeued"] == 0
    assert run("resume")["mode"] == "running"
    Installation.objects.update(owner=None)
    with pytest.raises(CommandError):
        run("diagnose")


def test_operator_report_has_numbers_and_hashes_users_never_see(
    users, project, source, operator, artifact_root
):
    report = internal(operator, "diagnostics.installation").result
    assert report["storage"]["free_bytes"] > 0
    assert report["approved_recipes"] == []
    user_view = status(users["owner"], project)
    assert "free_bytes" not in user_view["storage"]
    assert "credentials" not in user_view and "approved_recipes" not in user_view
    # Distinct operator and user recovery text for the same cause.
    os.rename(artifact_root, artifact_root.with_name("gone"))
    op_finding = next(
        f
        for f in internal(operator, "diagnostics.installation").result["findings"]
        if f["code"] == "storage_root_missing"
    )
    user_finding = next(
        f
        for f in status(users["owner"], project)["findings"]
        if f["code"] == "storage_root_missing"
    )
    assert op_finding["recovery"] != user_finding["recovery"]
