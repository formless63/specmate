"""Database/contract evidence for BLD-001..005; no native tool compatibility claims."""

import hashlib
import io
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.db import DatabaseError, close_old_connections, transaction
from django.test import Client
from django.utils import timezone

from specmate.access.models import Installation, WorkspaceMember
from specmate.builds.dispatch import ack_outbox, ready_outbox, record_dispatch_failure
from specmate.builds.models import BuildAttempt, BuildOutbox, BuildStage, StageEvent, StageOutput
from specmate.builds.operations import authenticate_runner
from specmate.builds.recipes import MAX_ARG_BYTES
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
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob, SourceBundle, SourceBundleRevision

from .conftest import member, op
from .scope_helpers import workspace_of

SOURCE = b"synthetic source\n"
OUTPUT = b"synthetic result\n"
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


@pytest.fixture
def source(users, workspace):
    op(
        users["owner"],
        "source.register_blob",
        {
            "workspace_id": workspace_of(workspace),
            "sha256": digest(SOURCE),
            "size": len(SOURCE),
            "media_type": "text/plain",
        },
        attachments={"content": io.BytesIO(SOURCE)},
    )
    return op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(workspace),
            "name": "Synthetic input",
            "files": [
                {
                    "path": "source.txt",
                    "sha256": digest(SOURCE),
                    "media_type": "text/plain",
                    "rights": RIGHTS,
                }
            ],
        },
    )["revision_id"]


@pytest.fixture
def build_payload(workspace, source, recipe):
    return {
        "workspace_id": workspace_of(workspace),
        "source_revision_id": source,
        "recipe_id": recipe["id"],
    }


@pytest.fixture
def build(users, build_payload):
    return op(users["owner"], "build.request", build_payload, idempotency_key="build-one")


@pytest.fixture
def credential(users, workspace, recipe):
    Installation.objects.create(owner=users["owner"])
    return execute(
        "runner.enroll",
        Context(user=users["owner"], via="internal", request_id="enroll"),
        {
            "workspace_id": workspace_of(workspace),
            "name": "Synthetic runner",
            "recipe_ids": [recipe["id"]],
        },
    ).result


def runner_op(credential, name, payload=None, **context):
    return execute(
        name,
        Context(
            user=authenticate_runner(credential["token"]),
            via="api",
            request_id="runner-request",
            **context,
        ),
        payload or {},
    ).result


@pytest.fixture
def lease(users, build, credential):
    op(users["owner"], "build.dispatch", {"build_id": build["build_id"]})
    return runner_op(credential, "runner.lease")["lease"]


def fence(lease):
    return {"stage_id": lease["stage_id"], "fencing_token": lease["fencing_token"]}


def output_payload(lease):
    return {
        **fence(lease),
        "path": "result.txt",
        "sha256": digest(OUTPUT),
        "size": len(OUTPUT),
        "media_type": "text/plain",
        "rights": RIGHTS,
        "source_revision_id": lease["source_revision_id"],
    }


def upload(credential, lease, payload=None, data=OUTPUT):
    return runner_op(
        credential,
        "runner.output",
        payload or output_payload(lease),
        attachments={"content": io.BytesIO(data)},
    )


def success_receipt(lease):
    return {
        **fence(lease),
        "outcome": "succeeded",
        "exit_code": 0,
        "outputs": [{"path": "result.txt", "sha256": digest(OUTPUT)}],
    }


def test_build_request_requires_execution_authority_and_exact_scope(users, build_payload):
    with pytest.raises(PermissionDenied):
        op(users["editor"], "build.request", build_payload, idempotency_key="editor")
    with pytest.raises(NotFound):
        op(users["outsider"], "build.request", build_payload, idempotency_key="outside")
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "build.request",
            {**build_payload, "source_revision_id": str(uuid.uuid4())},
            idempotency_key="missing",
        )
    assert not BuildAttempt.objects.exists()


def test_build_submission_replay_is_one_attempt_stage_and_outbox(users, build_payload):
    with pytest.raises(ValidationFailed):
        op(users["owner"], "build.request", build_payload)
    first = op(users["owner"], "build.request", build_payload, idempotency_key="one")
    again = op(users["owner"], "build.request", build_payload, idempotency_key="one")
    assert first == again
    assert first["state"] == "waiting_dispatch"
    assert first["workflow_id"] == f"specmate-build-{first['build_id']}"
    assert (
        BuildAttempt.objects.count()
        == BuildStage.objects.count()
        == BuildOutbox.objects.count()
        == 1
    )
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "build.request",
            {**build_payload, "recipe_id": "other"},
            idempotency_key="one",
        )


def test_request_rolls_back_attempt_stage_and_outbox_together(users, build_payload):
    with patch("specmate.builds.operations._event", side_effect=RuntimeError("injected failure")):
        with pytest.raises(RuntimeError):
            op(users["owner"], "build.request", build_payload, idempotency_key="one")
    assert not BuildAttempt.objects.exists()
    assert not BuildStage.objects.exists()
    assert not BuildOutbox.objects.exists()


def test_recipe_rights_never_refuse_a_build(users, build_payload, settings):
    settings.SPECMATE_APPROVED_RECIPES[build_payload["recipe_id"]]["outputs"][0]["rights"] = "other"
    result = op(users["owner"], "build.request", build_payload, idempotency_key="other-rights")
    assert BuildAttempt.objects.filter(id=result["build_id"]).exists()


def _mixed_source(users, workspace, rights_by_path):
    files = []
    for path, rights in rights_by_path.items():
        data = f"content of {path}\n".encode()
        op(
            users["owner"],
            "source.register_blob",
            {
                "workspace_id": workspace_of(workspace),
                "sha256": digest(data),
                "size": len(data),
                "media_type": "text/plain",
            },
            attachments={"content": io.BytesIO(data)},
        )
        files.append(
            {"path": path, "sha256": digest(data), "media_type": "text/plain", "rights": rights}
        )
    return op(
        users["owner"],
        "source.create_original_bundle",
        {"workspace_id": workspace_of(workspace), "name": "Mixed", "files": files},
    )["revision_id"]


@pytest.mark.parametrize(
    ("rights_by_path", "expected", "basis"),
    [
        ({"a.txt": "MIT", "b.txt": "MIT"}, "MIT", "uniform"),
        ({"a.txt": "MIT", "b.txt": "Proprietary"}, "Proprietary", "most_restrictive"),
        ({"a.txt": "MIT", "b.txt": "CC-BY-4.0"}, "unknown", "unknown"),
        ({"a.txt": "MIT", "b.txt": "unknown"}, "unknown", "unknown"),
    ],
)
def test_mixed_rights_are_staged_recorded_and_outputs_derive_conservatively(
    users, workspace, build_payload, credential, rights_by_path, expected, basis
):
    revision = _mixed_source(users, workspace, rights_by_path)
    started = op(
        users["owner"],
        "build.request",
        {**build_payload, "source_revision_id": revision},
        idempotency_key="mixed",
    )
    op(users["owner"], "build.dispatch", {"build_id": started["build_id"]})
    lease = runner_op(credential, "runner.lease")["lease"]
    # The runner restates the recipe's rights; they never gate registration.
    upload(credential, lease)
    runner_op(credential, "runner.complete", success_receipt(lease))

    history = op(users["owner"], "build.history", {"build_id": started["build_id"]})
    assert {e["path"]: e["rights"] for e in history["staged_inputs"]} == rights_by_path
    assert all(
        e["sha256"] and e["bytes"] and e["media_type"] == "text/plain"
        for e in history["staged_inputs"]
    )
    assert history["output_rights"] == {"rights": expected, "basis": basis}
    assert [o["rights"] for o in history["outputs"]] == [expected]
    assert StageOutput.objects.get().rights == expected


def test_staged_inputs_are_retained_verbatim_on_retry(users, workspace, build_payload):
    revision = _mixed_source(users, workspace, {"a.txt": "MIT", "b.txt": "Proprietary"})
    first = op(
        users["owner"],
        "build.request",
        {**build_payload, "source_revision_id": revision},
        idempotency_key="mixed-first",
    )
    assert BuildAttempt.objects.get(id=first["build_id"]).staged_inputs[1]["rights"] == (
        "Proprietary"
    )


def test_outbox_ack_loss_redelivery_has_stable_identity(build):
    first = ready_outbox()[0]
    record_dispatch_failure(first.id, "temporarily_unavailable")
    assert ready_outbox() == [first]
    ack_outbox(first.id)
    ack_outbox(first.id)
    assert ready_outbox() == []
    assert BuildOutbox.objects.get(id=first.id).delivery_attempts == 2


def test_dispatch_is_trusted_and_required_before_lease(users, build, credential):
    assert runner_op(credential, "runner.lease") == {"lease": None}
    with pytest.raises(PermissionDenied):
        execute(
            "build.dispatch",
            Context(user=users["owner"], via="api", request_id="bad"),
            {"build_id": build["build_id"]},
        )
    with pytest.raises(NotFound):
        op(users["outsider"], "build.dispatch", {"build_id": build["build_id"]})
    first = op(users["owner"], "build.dispatch", {"build_id": build["build_id"]})
    assert op(users["owner"], "build.dispatch", {"build_id": build["build_id"]}) == first


def test_lost_claim_reuses_lease_and_inputs_are_exact(credential, lease):
    assert runner_op(credential, "runner.lease")["lease"] == {
        **lease,
        "reconciliation_required": True,
    }
    assert lease["inputs"] == [
        {
            "path": "source.txt",
            "sha256": digest(SOURCE),
            "bytes": len(SOURCE),
            "media_type": "text/plain",
            "rights": RIGHTS,
        }
    ]
    assert runner_op(credential, "runner.input", {**fence(lease), "sha256": digest(SOURCE)})[
        "size"
    ] == len(SOURCE)
    with pytest.raises(NotFound):
        runner_op(credential, "runner.input", {**fence(lease), "sha256": digest(b"outside")})


def test_upload_and_completion_lost_receipts_are_idempotent(credential, lease):
    first = upload(credential, lease)
    assert upload(credential, lease) == first
    receipt = success_receipt(lease)
    completed = runner_op(credential, "runner.complete", receipt)
    BuildStage.objects.filter(id=lease["stage_id"]).update(
        lease_expires_at=timezone.now() - timedelta(seconds=1)
    )
    # Replaying either lost acknowledgment never repeats execution or changes evidence.
    assert upload(credential, lease) == first
    result = runner_op(credential, "runner.complete", receipt)
    assert result["state"] == completed["state"] == "succeeded"
    assert StageOutput.objects.count() == 1
    assert StageEvent.objects.filter(kind="completed").count() == 1
    with blobstore.open_blob(digest(OUTPUT)) as stored:
        assert stored.read() == OUTPUT
    with pytest.raises(Conflict):
        runner_op(credential, "runner.complete", {**receipt, "outcome": "failed"})


@pytest.mark.parametrize(
    "changed",
    [
        {"path": "../result.txt"},
        {"sha256": "f" * 64},
        {"size": 5000},
        {"media_type": "application/x-executable"},
        {"source_revision_id": str(uuid.uuid4())},
    ],
)
def test_output_rejects_corruption_traversal_wrong_type_source(credential, lease, changed):
    with pytest.raises(ValidationFailed):
        upload(credential, lease, {**output_payload(lease), **changed})
    assert not StageOutput.objects.exists()
    assert not blobstore.blob_path(digest(OUTPUT)).exists()


def test_success_requires_complete_verified_outputs(credential, lease):
    with pytest.raises(ValidationFailed):
        runner_op(credential, "runner.complete", success_receipt(lease))
    upload(credential, lease)
    with pytest.raises(ValidationFailed):
        runner_op(credential, "runner.complete", {**success_receipt(lease), "exit_code": 1})


def test_expiry_interrupts_never_requeues_and_reconciliation_recovers_same_execution(
    users, build, credential, lease
):
    BuildStage.objects.filter(id=lease["stage_id"]).update(
        lease_expires_at=timezone.now() - timedelta(seconds=1)
    )
    with pytest.raises(Conflict):
        upload(credential, lease)
    assert (
        op(users["owner"], "build.poll", {"build_id": build["build_id"]})["state"] == "interrupted"
    )
    recovered = runner_op(credential, "runner.lease")["lease"]
    assert recovered["fencing_token"] == lease["fencing_token"]
    assert recovered["reconciliation_required"] is True
    reconciliation = runner_op(
        credential,
        "runner.reconcile",
        {
            **fence(lease),
            "container_id": "synthetic-container",
            "observed": "stopped",
        },
    )
    assert reconciliation["state"] == "interrupted"
    upload(credential, lease)
    assert runner_op(credential, "runner.complete", success_receipt(lease))["state"] == "succeeded"


def test_stale_fence_cannot_heartbeat_read_upload_or_complete(credential, lease):
    stale = {**fence(lease), "fencing_token": str(uuid.uuid4())}
    with pytest.raises(Conflict):
        runner_op(credential, "runner.heartbeat", stale)
    with pytest.raises(Conflict):
        runner_op(credential, "runner.input", {**stale, "sha256": digest(SOURCE)})
    with pytest.raises(Conflict):
        upload(credential, lease, {**output_payload(lease), **stale})
    with pytest.raises(Conflict):
        runner_op(credential, "runner.complete", {**success_receipt(lease), **stale})


def test_cancel_is_requested_until_real_runner_confirmation(users, build, credential, lease):
    current = op(users["owner"], "build.get", {"build_id": build["build_id"]})
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "build.cancel",
            {"build_id": build["build_id"]},
            expected_state="stage-v0",
        )
    cancelled = op(
        users["owner"],
        "build.cancel",
        {"build_id": build["build_id"]},
        expected_state=current["state_token"],
    )
    assert cancelled["state"] == "cancellation_requested" and cancelled["terminal"] is False
    assert runner_op(credential, "runner.heartbeat", fence(lease))["cancellation_requested"] is True
    with pytest.raises(PermissionDenied):
        runner_op(credential, "runner.complete", success_receipt(lease))
    assert (
        runner_op(credential, "runner.complete", {**fence(lease), "outcome": "cancelled"})["state"]
        == "cancelled"
    )


def test_cancel_after_lost_upload_receipt_preserves_verified_incomplete_outputs(
    users,
    build,
    credential,
    lease,
):
    output = upload(credential, lease)
    current = op(users["owner"], "build.get", {"build_id": build["build_id"]})
    op(
        users["owner"],
        "build.cancel",
        {"build_id": build["build_id"]},
        expected_state=current["state_token"],
    )
    reconciliation = {**fence(lease), "container_id": "stopped-container", "observed": "stopped"}
    recovered = runner_op(credential, "runner.reconcile", reconciliation)
    verified = [{"path": "result.txt", "sha256": digest(OUTPUT)}]
    assert recovered["cancellation_requested"] is True
    assert recovered["verified_outputs"] == verified
    result = runner_op(
        credential,
        "runner.complete",
        {
            **fence(lease),
            "outcome": "cancelled",
            "outputs": recovered["verified_outputs"],
        },
    )
    assert result["state"] == "cancelled"
    assert runner_op(credential, "runner.reconcile", reconciliation)["verified_outputs"] == verified
    # Partial evidence remains stored but cannot enter the successful artifact view.
    assert StageOutput.objects.filter(id=output["output_id"]).exists()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "build.output",
            {
                "build_id": build["build_id"],
                "output_id": output["output_id"],
            },
        )


def test_revoked_execution_stops_new_inputs_and_requests_cancellation(
    users, workspace, build, credential, lease
):
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["owner"]).update(
        role="viewer"
    )
    assert runner_op(credential, "runner.heartbeat", fence(lease))["cancellation_requested"] is True
    with pytest.raises(PermissionDenied):
        runner_op(credential, "runner.input", {**fence(lease), "sha256": digest(SOURCE)})
    with pytest.raises(PermissionDenied):
        upload(credential, lease)
    assert (
        runner_op(credential, "runner.complete", {**fence(lease), "outcome": "cancelled"})["state"]
        == "cancelled"
    )


def test_revoked_runner_is_not_authorized_by_stale_identity(users, credential, lease):
    identity = authenticate_runner(credential["token"])
    execute(
        "runner.revoke",
        Context(user=users["owner"], via="internal", request_id="revoke"),
        {"credential_id": credential["credential_id"]},
    )
    assert authenticate_runner(credential["token"]) is None
    with pytest.raises(Unauthenticated):
        execute(
            "runner.heartbeat", Context(user=identity, via="api", request_id="stale"), fence(lease)
        )


def test_database_protects_attempt_output_and_accepted_receipt(credential, lease):
    upload(credential, lease)
    runner_op(credential, "runner.complete", success_receipt(lease))
    for mutation in [
        lambda: BuildAttempt.objects.update(recipe_id="rewritten"),
        lambda: StageOutput.objects.update(rights="rewritten"),
        lambda: BuildStage.objects.update(receipt={"outcome": "failed"}),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            mutation()


def test_api_requests_use_operations_and_runner_auth_is_separate(users, build_payload, credential):
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        {
            "operation": "build.request",
            "request_id": "api-build",
            "idempotency_key": "api",
            "payload": build_payload,
        },
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    assert response.json()["status"] == "accepted_async"
    assert BuildOutbox.objects.count() == 1
    # Session owner authority cannot impersonate a runner or enroll via a browser.
    assert (
        client.post(
            "/api/v0/runner/leases", {"request_id": "lease"}, content_type="application/json"
        ).status_code
        == 401
    )
    response = client.post(
        "/api/v0/operations",
        {
            "operation": "runner.enroll",
            "request_id": "bad",
            "payload": {
                "workspace_id": build_payload["workspace_id"],
                "name": "bad",
                "recipe_ids": [build_payload["recipe_id"]],
            },
        },
        content_type="application/json",
    )
    assert response.status_code == 403
    response = client.post(
        "/api/v0/runner/leases",
        {"request_id": "lease"},
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {credential['token']}",
    )
    assert response.status_code == 200, response.content
    assert response.json()["result"] == {"lease": None}


def test_artifact_download_rechecks_current_project_membership(users, workspace, credential, lease):
    output = upload(credential, lease)
    runner_op(credential, "runner.complete", success_receipt(lease))
    client = Client()
    client.force_login(users["viewer"])
    url = f"/api/v0/builds/{lease['build_id']}/outputs/{output['output_id']}"
    response = client.get(url)
    assert response.status_code == 200, response.content
    assert b"".join(response.streaming_content) == OUTPUT
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["viewer"]).delete()
    assert client.get(url).status_code == 404


@pytest.mark.django_db(transaction=True)
def test_parallel_claims_do_not_duplicate_stage_execution(users, build, credential):
    op(users["owner"], "build.dispatch", {"build_id": build["build_id"]})

    def claim():
        close_old_connections()
        try:
            return runner_op(credential, "runner.lease")["lease"]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        left, right = list(pool.map(lambda _: claim(), range(2)))
    assert left["stage_id"] == right["stage_id"]
    assert left["fencing_token"] == right["fencing_token"]
    assert StageEvent.objects.filter(kind="leased").count() == 1


def test_inactive_requester_can_only_be_polled_for_safe_cleanup(users, build, credential, lease):
    users["owner"].is_active = False
    users["owner"].save(update_fields=["is_active"])
    result = op(users["owner"], "build.poll", {"build_id": build["build_id"]})
    assert result["state"] == "cancellation_requested"
    assert runner_op(credential, "runner.heartbeat", fence(lease))["cancellation_requested"] is True
    with pytest.raises(Unauthenticated):
        op(users["owner"], "build.get", {"build_id": build["build_id"]})


def test_another_runner_cannot_read_or_complete_existing_lease(users, workspace, recipe, lease):
    other = execute(
        "runner.enroll",
        Context(user=users["owner"], via="internal", request_id="enroll-other"),
        {"workspace_id": workspace, "name": "Other runner", "recipe_ids": [recipe["id"]]},
    ).result
    assert runner_op(other, "runner.lease") == {"lease": None}
    with pytest.raises(NotFound):
        runner_op(other, "runner.heartbeat", fence(lease))
    with pytest.raises(NotFound):
        runner_op(other, "runner.input", {**fence(lease), "sha256": digest(SOURCE)})
    with pytest.raises(NotFound):
        runner_op(other, "runner.complete", {**fence(lease), "outcome": "failed"})


@pytest.mark.parametrize(
    "limit,value",
    [
        ("cpus", 0.05),
        ("cpus", 33),
        ("memory_bytes", 64 * 1024**3 + 1),
        ("pids", 1025),
        ("max_output_bytes", 64 * 1024**2 + 1),
    ],
)
def test_build_rejects_limits_outside_runner_capability_without_outbox(
    users,
    build_payload,
    recipe,
    limit,
    value,
):
    recipe["limits"][limit] = value
    with pytest.raises(ValidationFailed):
        op(users["owner"], "build.request", build_payload, idempotency_key="unsupported-limit")
    assert not BuildAttempt.objects.exists()
    assert not BuildOutbox.objects.exists()


@pytest.mark.parametrize(
    "change",
    [
        {"argv": ["relative-command"]},
        {"argv": ["/tool", "x" * (MAX_ARG_BYTES + 1)]},
        {"image": "example.invalid/Uppercase@sha256:" + "1" * 64},
        {"paths": ["file", "file/nested.txt"]},
        {"paths": ["directory/" * 32 + "result.txt"]},
        {"paths": [f"result-{i}.txt" for i in range(513)]},
    ],
)
def test_build_rejects_recipe_shapes_unsupported_by_runner(users, build_payload, recipe, change):
    if "paths" in change:
        recipe["outputs"] = [
            {"path": path, "media_type": "text/plain", "rights": RIGHTS} for path in change["paths"]
        ]
    else:
        recipe.update(change)
    with pytest.raises(ValidationFailed):
        op(users["owner"], "build.request", build_payload, idempotency_key="unsupported-shape")
    assert not BuildAttempt.objects.exists()
    assert not BuildOutbox.objects.exists()


@pytest.mark.parametrize(
    "sizes,paths",
    [
        ([64 * 1024**2 + 1], ["large.bin"]),
        ([64 * 1024**2] * 5, [f"large-{i}.bin" for i in range(5)]),
        ([0] * 513, [f"empty-{i}.bin" for i in range(513)]),
        ([0, 0], ["directory", "directory/source.bin"]),
    ],
)
def test_build_rejects_oversized_or_colliding_source_bundles_before_outbox(
    users,
    workspace,
    recipe,
    sizes,
    paths,
):
    # Metadata fixtures avoid allocating oversized files: submission must reject
    # unsupported source manifests before accessing content storage or making work.
    hashes = {}
    for size in set(sizes):
        sha256 = digest(f"synthetic declared size {size}".encode())
        SourceBlob.objects.create(
            workspace_id=workspace,
            sha256=sha256,
            size=size,
            media_type="application/octet-stream",
            registered_by=users["owner"],
        )
        hashes[size] = sha256
    if paths == ["directory", "directory/source.bin"]:
        # Deliberately invalid metadata retains build defense-in-depth coverage;
        # normal source intake now rejects this tree before committing a revision.
        bundle = SourceBundle.objects.create(
            workspace_id=workspace,
            name="Invalid metadata fixture",
            role="original",
            created_by=users["owner"],
        )
        manifest = {
            "files": [
                {
                    "path": path,
                    "sha256": hashes[size],
                    "bytes": size,
                    "media_type": "application/octet-stream",
                    "rights": RIGHTS,
                }
                for path, size in zip(paths, sizes, strict=True)
            ]
        }
        raw = json.dumps(manifest).encode()
        revision = SourceBundleRevision.objects.create(
            bundle=bundle,
            number=1,
            manifest=raw,
            manifest_sha256=digest(raw),
            created_by=users["owner"],
        )
        source = {"revision_id": str(revision.id)}
    else:
        source = op(
            users["owner"],
            "source.create_original_bundle",
            {
                "workspace_id": workspace,
                "name": "Unsupported execution input",
                "files": [
                    {
                        "path": path,
                        "sha256": hashes[size],
                        "media_type": "application/octet-stream",
                        "rights": RIGHTS,
                    }
                    for path, size in zip(paths, sizes, strict=True)
                ],
            },
        )
    error = (
        "path collision" if paths == ["directory", "directory/source.bin"] else "capability limits"
    )
    with pytest.raises(ValidationFailed, match=error):
        op(
            users["owner"],
            "build.request",
            {
                "workspace_id": workspace,
                "source_revision_id": source["revision_id"],
                "recipe_id": recipe["id"],
            },
            idempotency_key="unsupported-input",
        )
    assert not BuildAttempt.objects.exists()
    assert not BuildOutbox.objects.exists()


def test_build_is_a_workspace_record_with_optional_project_context(
    users, workspace, project, build_payload, build
):
    attempt = BuildAttempt.objects.get(id=build["build_id"])
    assert str(attempt.workspace_id) == workspace and attempt.project_id is None
    listed = op(users["viewer"], "build.list", {"workspace_id": workspace})
    assert listed["workspace_id"] == workspace
    assert [b["build_id"] for b in listed["builds"]] == [build["build_id"]]
    contextual = op(
        users["owner"],
        "build.request",
        {**build_payload, "project_id": project},
        idempotency_key="build-context",
    )
    assert str(BuildAttempt.objects.get(id=contextual["build_id"]).project_id) == project
    filtered = op(users["viewer"], "build.list", {"workspace_id": workspace, "project_id": project})
    assert [b["build_id"] for b in filtered["builds"]] == [contextual["build_id"]]
    assert filtered["builds"][0]["project_id"] == project
    # Context grants and limits nothing: any workspace member reads the build.
    history = op(users["viewer"], "build.history", {"build_id": contextual["build_id"]})
    assert history["workspace_id"] == workspace and history["project_id"] == project


def test_project_context_must_belong_to_the_workspace(users, build_payload, other_workspace):
    foreign = op(
        users["outsider"], "project.create", {"workspace_id": other_workspace, "name": "F"}
    )
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "build.request",
            {**build_payload, "project_id": foreign["project_id"]},
            idempotency_key="foreign-context",
        )


def test_build_execute_is_a_grant_held_by_admins_by_default(users, build_payload):
    for name in ("editor", "contributor", "viewer"):
        with pytest.raises(PermissionDenied):
            op(users[name], "build.request", build_payload, idempotency_key=f"deny-{name}")
    member(users["editor"], "editor", grants=["build.execute"])
    granted = op(users["editor"], "build.request", build_payload, idempotency_key="granted")
    assert granted["state"] == "waiting_dispatch"
    with pytest.raises(NotFound):
        op(users["outsider"], "build.request", build_payload, idempotency_key="outsider")


def test_runner_credential_is_scoped_to_its_workspace_and_recipes(
    users, build, credential, workspace, other_workspace
):
    assert credential["workspace_id"] == workspace
    op(users["owner"], "build.dispatch", {"build_id": build["build_id"]})
    leased = runner_op(credential, "runner.lease")["lease"]
    assert leased["build_id"] == build["build_id"]
    with pytest.raises(NotFound):
        execute(
            "runner.enroll",
            Context(user=users["owner"], via="internal", request_id="foreign-enroll"),
            {"workspace_id": other_workspace, "name": "x", "recipe_ids": ["synthetic-check-r1"]},
        )


def test_disabled_adapter_refuses_new_builds_but_keeps_earlier_evidence(
    users, workspace, build_payload, recipe, credential
):
    manifest = {
        "kind": "adapter",
        "package_key": "synthetic.adapter",
        "label": "Synthetic adapter",
        "version": "1.0",
        "publisher": "Synthetic publisher",
        "rights": RIGHTS,
        "requested_authority": [
            {"kind": "execution", "scope": "synthetic", "reason": "Run the check."}
        ],
        "entries": [
            {
                "key": "check",
                "label": "Check recipe",
                "category": "recipe_reference",
                "recipe": {"recipe_id": recipe["id"], "version": "1", "digest": "a" * 64},
                "rights": RIGHTS,
            }
        ],
    }
    version = op(
        users["owner"],
        "catalog_pack.register",
        {"workspace_id": workspace_of(workspace), "manifest": manifest},
    )
    # Registered but never enabled: the adapter's recipe is refused.
    with pytest.raises(Unsupported, match="Adapter disabled"):
        op(users["owner"], "build.request", build_payload, idempotency_key="before-enable")
    installed = op(
        users["owner"],
        "catalog_pack.install",
        {"pack_id": version["pack_id"], "version_id": version["version_id"], "basis": "Enable."},
        expected_state="pack-v0",
    )
    build = op(users["owner"], "build.request", build_payload, idempotency_key="enabled")
    op(users["owner"], "build.dispatch", {"build_id": build["build_id"]})
    lease = runner_op(credential, "runner.lease")["lease"]
    output = upload(credential, lease)
    runner_op(credential, "runner.complete", success_receipt(lease))

    op(
        users["owner"],
        "catalog_pack.disable",
        {"pack_id": version["pack_id"], "basis": "Stop."},
        expected_state=installed["state"],
    )
    with pytest.raises(Unsupported, match="Adapter disabled"):
        op(users["owner"], "build.request", build_payload, idempotency_key="after-disable")
    # The earlier build and its output stay retrievable and downloadable.
    client = Client()
    client.force_login(users["viewer"])
    base = f"/api/v0/builds/{lease['build_id']}"
    response = client.get(f"{base}/outputs/{output['output_id']}")
    assert response.status_code == 200
    assert b"".join(response.streaming_content) == OUTPUT
