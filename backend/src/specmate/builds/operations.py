"""Build, lease and receipt authority shared by HTTP and trusted jobs.

An interrupted stage is never automatically requeued. Its owning runner can reconcile
the same execution and fencing token; a new execution requires a new build request.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Literal
from uuid import UUID

from django.conf import settings
from django.db.models import Sum
from django.utils import timezone
from pydantic import BaseModel, ConfigDict, Field, field_validator

from specmate.access.models import Installation
from specmate.access.permissions import Perm, authorize, context_project
from specmate.builds.models import (
    BuildAttempt,
    BuildOutbox,
    BuildStage,
    RunnerCredential,
    StageEvent,
    StageOutput,
)
from specmate.builds.recipes import (
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_INPUT_BYTES,
    Recipe,
    approved_recipe,
    check_file_tree,
)
from specmate.contracts import SHA256, check_package_path
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    OperationError,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
    operation,
)
from specmate.operations.core import ACCESS_OPERATOR, ACCESS_RUNNER, ACCESS_TRUSTED_JOB, Requirement
from specmate.operations.scope import WorkspacePayload, WorkspaceProjectPayload
from specmate.sources import blobstore
from specmate.sources.models import SourceBundleRevision

TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
ACTIVE = frozenset({"leased", "running", "cancellation_requested", "interrupted"})


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True)
class RunnerIdentity:
    credential_id: UUID
    is_authenticated: bool = True


def authenticate_runner(token: str) -> RunnerIdentity | None:
    if not token or len(token) > 256:
        return None
    credential = RunnerCredential.objects.filter(
        token_sha256=hashlib.sha256(token.encode()).hexdigest(),
        revoked_at__isnull=True,
        expires_at__gt=timezone.now(),
    ).first()
    return RunnerIdentity(credential.id) if credential else None


def _runner(ctx: Context) -> RunnerCredential:
    if not isinstance(ctx.user, RunnerIdentity):
        raise PermissionDenied("A scoped runner credential is required.")
    # Serialize claims by one runner and recheck revocation on each operation.
    credential = (
        RunnerCredential.objects.select_for_update()
        .filter(
            id=ctx.user.credential_id,
            revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
        )
        .first()
    )
    if credential is None:
        raise Unauthenticated("Runner credential is no longer valid.")
    return credential


def _event(stage: BuildStage, kind: str, **detail) -> None:
    StageEvent.objects.create(stage=stage, kind=kind, detail=detail)


def _save(stage: BuildStage) -> None:
    stage.version += 1
    stage.save()


def stage_result(stage: BuildStage) -> dict:
    return {
        "build_id": str(stage.build_id),
        "stage_id": str(stage.id),
        "state": stage.state,
        "state_token": f"stage-v{stage.version}",
        "terminal": stage.state in TERMINAL or stage.state == "interrupted",
        "lease_expires_at": stage.lease_expires_at.isoformat() if stage.lease_expires_at else None,
        "cancellation_requested": stage.cancellation_requested_at is not None,
    }


def _lease_expiry():
    return timezone.now() + timedelta(seconds=settings.SPECMATE_LEASE_SECONDS)


def _execution_allowed(build: BuildAttempt) -> bool:
    if not build.requested_by.is_active:
        return False
    try:
        authorize(build.requested_by, build.workspace_id, Perm.BUILD_EXECUTE)
        recipe = approved_recipe(build.recipe_id)
        from specmate.firmware_builds.operations import execution_allowed

        execution_allowed(build)
        return recipe.model_dump(mode="json") == build.recipe
    except OperationError:
        return False


def _cancel(stage: BuildStage, reason: str) -> None:
    if stage.state in TERMINAL:
        return
    stage.cancellation_requested_at = stage.cancellation_requested_at or timezone.now()
    if stage.state in {"waiting_dispatch", "queued"}:
        stage.state = "cancelled"
        stage.receipt = {"outcome": "cancelled", "reason": reason, "execution_started": False}
    else:
        stage.state = "cancellation_requested"
    _save(stage)
    _event(stage, "cancellation_requested", reason=reason)


def _expire(stage: BuildStage) -> None:
    if (
        stage.state in ACTIVE - {"interrupted"}
        and stage.lease_expires_at is not None
        and stage.lease_expires_at <= timezone.now()
    ):
        stage.state = "interrupted"
        _save(stage)
        _event(stage, "lease_expired")


class RequestBuild(WorkspaceProjectPayload):
    """A workspace build; ``project_id`` is optional navigation context only."""

    source_revision_id: UUID
    recipe_id: str = Field(min_length=1, max_length=128)
    # Optional exact, complete resolved configuration (CFG-001) this build consumes.
    resolved_configuration_id: UUID | None = None


def configuration_input(ctx: Context, workspace, configuration_id: UUID | None) -> dict | None:
    """The exact build input of a same-workspace resolved configuration, or None."""
    if configuration_id is None:
        return None
    from specmate.configurations.contracts import ResolvedRef
    from specmate.configurations.models import ResolvedConfiguration
    from specmate.configurations.operations import build_input

    # Cross-workspace ids are NotFound here, before any database guard can fire.
    if not ResolvedConfiguration.objects.filter(id=configuration_id, workspace=workspace).exists():
        raise NotFound("Resolved configuration unavailable.")
    # Authorizes the snapshot closure and refuses incomplete resolutions.
    return build_input(ctx, ResolvedRef(resolved_configuration_id=configuration_id))


@operation(
    "build.request",
    RequestBuild,
    summary="Request an approved isolated build from an exact immutable source revision.",
    status="accepted_async",
    access=Perm.BUILD_EXECUTE,
)
def request_build(ctx: Context, p: RequestBuild) -> dict:
    workspace = authorize(ctx.user, p.workspace_id, Perm.BUILD_EXECUTE)
    context = context_project(p.project_id, workspace)
    if not ctx.idempotency_key:
        raise ValidationFailed("build.request requires an idempotency key.")
    from specmate.diagnostics.guards import require_accepting_work

    require_accepting_work()
    source = SourceBundleRevision.objects.filter(
        id=p.source_revision_id, bundle__workspace=workspace
    ).first()
    if source is None:
        raise NotFound("Source revision not found.")
    recipe = approved_recipe(p.recipe_id)
    configuration = configuration_input(ctx, workspace, p.resolved_configuration_id)
    return _create_attempt(
        ctx, workspace, source, recipe, p, project=context, configuration=configuration
    )


def _create_attempt(
    ctx,
    workspace,
    source,
    recipe,
    p,
    retry_of: BuildAttempt | None = None,
    project=None,
    configuration: dict | None = None,
) -> dict:
    """Shared by first requests and deliberate retries; every attempt gets a new identity."""
    from specmate.firmware_builds.operations import authorize_request

    authorize_request(ctx, p, recipe)
    inputs = json.loads(bytes(source.manifest))["files"]
    if (
        len(inputs) > MAX_FILES
        or any(entry["bytes"] > MAX_FILE_BYTES for entry in inputs)
        or sum(entry["bytes"] for entry in inputs) > MAX_INPUT_BYTES
    ):
        raise ValidationFailed("Source bundle exceeds this runner's input capability limits.")
    try:
        check_file_tree([entry["path"] for entry in inputs])
    except ValueError:
        raise ValidationFailed("Source bundle has a file/directory path collision.") from None
    source_rights = set(source.files.values_list("rights", flat=True))
    if any(source_rights != {output.rights} for output in recipe.outputs):
        raise ValidationFailed("Output rights must preserve the declared source rights.")
    if retry_of is not None:
        # A retry reuses the original attempt's exact retained configuration input.
        configuration = retry_of.configuration_input
    build_id = uuid.uuid4()
    build = BuildAttempt.objects.create(
        id=build_id,
        workspace=workspace,
        # Optional navigation context; a retry keeps the original attempt's context.
        project=retry_of.project if retry_of else project,
        requested_by=ctx.user,
        source_revision=source,
        recipe_id=recipe.id,
        recipe=recipe.model_dump(mode="json"),
        workflow_id=f"specmate-build-{build_id}",
        retry_of=retry_of,
        resolved_configuration_id=(
            configuration["resolved_configuration_id"] if configuration else None
        ),
        configuration_input=configuration,
    )
    stage = BuildStage.objects.create(build=build)
    BuildOutbox.objects.create(build=build)
    _event(
        stage,
        "requested",
        request_id=ctx.request_id,
        **({"retry_of": str(retry_of.id)} if retry_of else {}),
    )
    return {**stage_result(stage), "workflow_id": build.workflow_id}


class BuildRef(Payload):
    build_id: UUID


def _stage_for_build(build_id: UUID) -> BuildStage:
    stage = (
        BuildStage.objects.select_for_update()
        .select_related("build", "build__requested_by", "build__source_revision")
        .filter(build_id=build_id)
        .first()
    )
    if stage is None:
        raise NotFound("Build not found.")
    return stage


def _job_stage(ctx: Context, p: BuildRef) -> BuildStage:
    if ctx.via != "job":
        raise PermissionDenied("This operation requires the trusted jobs adapter.")
    stage = _stage_for_build(p.build_id)
    if ctx.user.pk != stage.build.requested_by_id:
        raise NotFound("Build not found.")
    return stage


@operation(
    "build.dispatch",
    BuildRef,
    summary="Make an outbox-dispatched build available to runners.",
    supports_idempotency=False,
    access=ACCESS_TRUSTED_JOB,
)
def dispatch_build(ctx: Context, p: BuildRef) -> dict:
    stage = _job_stage(ctx, p)
    if not _execution_allowed(stage.build):
        _cancel(stage, "execution_authority_revoked")
    elif stage.state == "waiting_dispatch":
        stage.state = "queued"
        _save(stage)
        _event(stage, "dispatched")
    return stage_result(stage)


@operation(
    "build.poll",
    BuildRef,
    summary="Reconcile build liveness for its trusted workflow.",
    supports_idempotency=False,
    access=ACCESS_TRUSTED_JOB,
)
def poll_build(ctx: Context, p: BuildRef) -> dict:
    stage = _job_stage(ctx, p)
    if not _execution_allowed(stage.build) and stage.cancellation_requested_at is None:
        _cancel(stage, "execution_authority_revoked")
    _expire(stage)
    return stage_result(stage)


@operation(
    "build.get",
    BuildRef,
    summary="Read the state of a build within its workspace.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def get_build(ctx: Context, p: BuildRef) -> dict:
    stage = _stage_for_build(p.build_id)
    authorize(ctx.user, stage.build.workspace_id, Perm.WORKSPACE_READ)
    _authorize_compiler_read(ctx, stage)
    return {**stage_result(stage), "receipt": stage.receipt}


class ArtifactRef(BuildRef):
    output_id: UUID


@operation(
    "build.output",
    ArtifactRef,
    summary="Authorize accepted artifact bytes in workspace scope.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def get_output(ctx: Context, p: ArtifactRef) -> dict:
    stage = _stage_for_build(p.build_id)
    authorize(ctx.user, stage.build.workspace_id, Perm.WORKSPACE_READ)
    _authorize_compiler_read(ctx, stage)
    if stage.state != "succeeded":
        raise NotFound("Accepted output not found.")
    output = stage.outputs.filter(id=p.output_id).first()
    if output is None:
        raise NotFound("Accepted output not found.")
    return {**_output_result(output), "media_type": output.media_type, "rights": output.rights}


def _authorize_compiler_read(ctx, stage):
    """Generic receipt/download adapters retain the exact compiler closure and acceptance gate."""
    from specmate.catalog_matching.queries import current_actor
    from specmate.firmware_builds.operations import recipe_inputs, validate_outputs
    from specmate.sources.authority import authorize_revision

    user = current_actor(ctx.user)
    recipe = Recipe.model_validate(stage.build.recipe)
    if recipe_inputs(user, recipe) is None:
        return
    for output in stage.outputs.select_related("source_revision__bundle"):
        authorize_revision(user, output.source_revision)
    if stage.state == "succeeded":
        validate_outputs(json.loads(recipe.argv[-1]), stage.build)


@operation(
    "build.cancel",
    BuildRef,
    summary="Request cancellation; a runner confirms actual termination.",
    requires_expected_state=True,
    access=Perm.WORKSPACE_READ,
)
def cancel_build(ctx: Context, p: BuildRef) -> dict:
    stage = _stage_for_build(p.build_id)
    authorize(ctx.user, stage.build.workspace_id, Perm.WORKSPACE_READ)
    if ctx.user.pk != stage.build.requested_by_id:
        authorize(ctx.user, stage.build.workspace_id, Perm.BUILD_EXECUTE)
    if ctx.expected_state != stage_result(stage)["state_token"]:
        raise Conflict("Build changed since expected state.", details=stage_result(stage))
    _cancel(stage, "requested")
    return stage_result(stage)


class EnrollRunner(WorkspacePayload):
    name: str = Field(min_length=1, max_length=200)
    recipe_ids: list[str] = Field(min_length=1, max_length=100)
    lifetime_hours: int = Field(default=24, ge=1, le=720)


def _operator(ctx: Context):
    installation = Installation.objects.filter(singleton=True).first()
    if ctx.via != "internal" or installation is None or installation.owner_id != ctx.user.pk:
        raise PermissionDenied("Local installation operator authority is required.")


@operation(
    "runner.enroll",
    EnrollRunner,
    summary="Issue a workspace and recipe scoped runner token.",
    supports_idempotency=False,
    access=Requirement("operator", Perm.WORKSPACE_ADMIN),
)
def enroll_runner(ctx: Context, p: EnrollRunner) -> dict:
    _operator(ctx)
    if ctx.idempotency_key:
        raise ValidationFailed("Credential issuance cannot retain an idempotent token response.")
    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_ADMIN)
    for recipe_id in p.recipe_ids:
        approved_recipe(recipe_id)
    token = secrets.token_urlsafe(48)
    credential = RunnerCredential.objects.create(
        name=p.name,
        workspace=workspace,
        recipe_ids=sorted(set(p.recipe_ids)),
        token_sha256=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=timezone.now() + timedelta(hours=p.lifetime_hours),
        created_by=ctx.user,
    )
    return {
        "credential_id": str(credential.id),
        "workspace_id": str(workspace.id),
        "token": token,
        "expires_at": credential.expires_at.isoformat(),
    }


class RevokeRunner(Payload):
    credential_id: UUID


@operation(
    "runner.revoke",
    RevokeRunner,
    summary="Revoke a runner credential locally.",
    access=ACCESS_OPERATOR,
)
def revoke_runner(ctx: Context, p: RevokeRunner) -> dict:
    _operator(ctx)
    credential = RunnerCredential.objects.select_for_update().filter(id=p.credential_id).first()
    if credential is None:
        raise NotFound("Runner not found.")
    credential.revoked_at = credential.revoked_at or timezone.now()
    credential.save(update_fields=["revoked_at"])
    for stage in BuildStage.objects.select_for_update().filter(runner=credential, state__in=ACTIVE):
        _cancel(stage, "runner_revoked")
    return {"credential_id": str(credential.id), "revoked": True}


class ClaimLease(Payload):
    pass


def _manifest(stage: BuildStage) -> dict:
    source = json.loads(bytes(stage.build.source_revision.manifest))
    return {
        "stage_id": str(stage.id),
        "build_id": str(stage.build_id),
        "fencing_token": str(stage.fencing_token),
        "lease_expires_at": stage.lease_expires_at.isoformat(),
        "source_revision_id": str(stage.build.source_revision_id),
        "recipe": stage.build.recipe,
        "inputs": source["files"],
        "configuration": stage.build.configuration_input,
        "reconciliation_required": stage.state != "leased",
        "cancellation_requested": stage.cancellation_requested_at is not None,
    }


@operation(
    "runner.lease",
    ClaimLease,
    summary="Claim one authorized stage lease.",
    public=True,
    supports_idempotency=False,
    access=ACCESS_RUNNER,
)
def claim_lease(ctx: Context, p: ClaimLease) -> dict:
    runner = _runner(ctx)
    existing = (
        BuildStage.objects.select_for_update()
        .select_related("build", "build__requested_by", "build__source_revision")
        .filter(runner=runner, state__in=ACTIVE)
        .order_by("created_at")
        .first()
    )
    if existing is not None:
        if not _execution_allowed(existing.build) and existing.cancellation_requested_at is None:
            _cancel(existing, "execution_authority_revoked")
        _expire(existing)
        # Any repeated claim may follow a lost acknowledgment or local restart.
        # Require reconciliation even if no heartbeat ever changed leased -> running.
        return {"lease": {**_manifest(existing), "reconciliation_required": True}}
    candidates = (
        BuildStage.objects.select_for_update(skip_locked=True)
        .select_related("build", "build__requested_by", "build__source_revision")
        .filter(
            state="queued",
            build__workspace=runner.workspace,
            build__recipe_id__in=runner.recipe_ids,
        )
        .order_by("created_at")[:20]
    )
    from specmate.diagnostics.guards import leasing_allowed

    if not leasing_allowed():
        return {"lease": None}
    for stage in candidates:
        if not _execution_allowed(stage.build):
            _cancel(stage, "execution_authority_revoked")
            continue
        stage.runner = runner
        stage.fencing_token = uuid.uuid4()
        stage.lease_expires_at = _lease_expiry()
        stage.state = "leased"
        _save(stage)
        _event(stage, "leased", runner_id=str(runner.id), fencing_token=str(stage.fencing_token))
        return {"lease": _manifest(stage)}
    return {"lease": None}


class StageLease(Payload):
    stage_id: UUID
    fencing_token: UUID


def _runner_stage(ctx: Context, p: StageLease, *, allow_expired=False, allow_terminal=False):
    runner = _runner(ctx)
    stage = (
        BuildStage.objects.select_for_update()
        .select_related("build", "build__requested_by", "build__source_revision")
        .filter(
            id=p.stage_id,
            runner=runner,
            build__workspace=runner.workspace,
            build__recipe_id__in=runner.recipe_ids,
        )
        .first()
    )
    if stage is None:
        raise NotFound("Stage not found.")
    if stage.fencing_token != p.fencing_token:
        raise Conflict("Stage fencing token is stale.")
    if stage.state in TERMINAL and not allow_terminal:
        raise Conflict("Stage already has a terminal receipt.")
    if not allow_expired and (
        stage.lease_expires_at is None or stage.lease_expires_at <= timezone.now()
    ):
        raise Conflict("Stage lease expired; reconcile before reporting work.")
    return stage


@operation(
    "runner.heartbeat",
    StageLease,
    summary="Renew a stage lease and read cancellation.",
    public=True,
    supports_idempotency=False,
    access=ACCESS_RUNNER,
)
def heartbeat(ctx: Context, p: StageLease) -> dict:
    stage = _runner_stage(ctx, p)
    if not _execution_allowed(stage.build):
        _cancel(stage, "execution_authority_revoked")
    elif stage.state == "leased":
        stage.state = "running"
    stage.lease_expires_at = _lease_expiry()
    _save(stage)
    return stage_result(stage)


class ReconcileLease(StageLease):
    container_id: str = Field(max_length=128)
    observed: Literal["running", "stopped", "absent"]


def _reconciliation_result(stage: BuildStage) -> dict:
    return {
        **stage_result(stage),
        "verified_outputs": list(stage.outputs.order_by("path").values("path", "sha256")),
    }


@operation(
    "runner.reconcile",
    ReconcileLease,
    summary="Reconcile the original execution before resuming receipts.",
    public=True,
    supports_idempotency=False,
    access=ACCESS_RUNNER,
)
def reconcile(ctx: Context, p: ReconcileLease) -> dict:
    stage = _runner_stage(ctx, p, allow_expired=True, allow_terminal=True)
    if stage.state in TERMINAL:
        return _reconciliation_result(stage)
    if p.observed == "running" and not p.container_id:
        raise ValidationFailed("A running observation requires its container identity.")
    if not _execution_allowed(stage.build) and stage.cancellation_requested_at is None:
        _cancel(stage, "execution_authority_revoked")
    stage.state = (
        "cancellation_requested"
        if stage.cancellation_requested_at
        else "running"
        if p.observed == "running"
        else "interrupted"
    )
    stage.lease_expires_at = _lease_expiry()
    _save(stage)
    _event(stage, "reconciled", observed=p.observed, container_id=p.container_id)
    return _reconciliation_result(stage)


class InputRef(StageLease):
    sha256: str = Field(pattern=SHA256)


@operation(
    "runner.input",
    InputRef,
    summary="Authorize one exact input in the leased manifest.",
    public=True,
    supports_idempotency=False,
    access=ACCESS_RUNNER,
)
def get_input(ctx: Context, p: InputRef) -> dict:
    stage = _runner_stage(ctx, p)
    if stage.cancellation_requested_at or not _execution_allowed(stage.build):
        raise PermissionDenied("Execution is no longer authorized.")
    entry = (
        stage.build.source_revision.files.select_related("blob")
        .filter(blob__sha256=p.sha256)
        .first()
    )
    if entry is None:
        raise NotFound("Input not found.")
    return {"sha256": entry.blob.sha256, "size": entry.blob.size, "media_type": entry.media_type}


class RegisterOutput(StageLease):
    path: str
    sha256: str = Field(pattern=SHA256)
    size: int = Field(ge=0)
    media_type: str = Field(min_length=1, max_length=200)
    rights: str = Field(min_length=1, max_length=200)
    source_revision_id: UUID

    @field_validator("path")
    @classmethod
    def portable_path(cls, value):
        return check_package_path(value)


def _output_result(output: StageOutput) -> dict:
    return {
        "output_id": str(output.id),
        "path": output.path,
        "sha256": output.sha256,
        "size": output.size,
    }


@operation(
    "runner.output",
    RegisterOutput,
    summary="Verify and register a scoped output receipt.",
    public=True,
    supports_idempotency=False,
    attachments=("content",),
    access=ACCESS_RUNNER,
)
def register_output(ctx: Context, p: RegisterOutput) -> dict:
    stage = _runner_stage(ctx, p, allow_expired=True, allow_terminal=True)
    spec = next((o for o in stage.build.recipe["outputs"] if o["path"] == p.path), None)
    if spec is None or spec["media_type"] != p.media_type or spec["rights"] != p.rights:
        raise ValidationFailed("Output path, type and rights must match the approved recipe.")
    if stage.build.source_revision_id != p.source_revision_id:
        raise ValidationFailed("Output source association does not match the leased revision.")
    previous = StageOutput.objects.filter(stage=stage, path=p.path).first()
    if previous is not None:
        if previous.sha256 != p.sha256 or previous.size != p.size:
            raise Conflict("Output path already has a different verified receipt.")
        # A lost acknowledgment can be retried after terminal acceptance or expiry.
        return _output_result(previous)
    if stage.state in TERMINAL:
        raise Conflict("Cannot add outputs after terminal acceptance.")
    if stage.lease_expires_at <= timezone.now():
        raise Conflict("Stage lease expired; reconcile before registering outputs.")
    if not _execution_allowed(stage.build):
        raise PermissionDenied("Execution is no longer authorized.")
    limit = stage.build.recipe["limits"]["max_output_bytes"]
    total = stage.outputs.aggregate(total=Sum("size"))["total"] or 0
    if total + p.size > limit:
        raise ValidationFailed("Output exceeds the approved total size limit.")
    try:
        staged = blobstore.stage(ctx.attachments["content"], limit - total)
    except blobstore.TooLarge:
        raise ValidationFailed("Output exceeds the approved total size limit.") from None
    if staged.sha256 != p.sha256 or staged.size != p.size:
        blobstore.discard(staged)
        raise ValidationFailed("Output bytes do not match declared hash and size.")
    blobstore.promote(staged)
    output = StageOutput.objects.create(
        stage=stage,
        path=p.path,
        sha256=p.sha256,
        size=p.size,
        media_type=p.media_type,
        rights=p.rights,
        source_revision_id=p.source_revision_id,
    )
    _event(stage, "output_verified", output_id=str(output.id), sha256=p.sha256)
    return _output_result(output)


class ReceiptOutput(Payload):
    path: str
    sha256: str = Field(pattern=SHA256)


class CompleteStage(StageLease):
    outcome: Literal["succeeded", "failed", "cancelled"]
    exit_code: int | None = None
    outputs: list[ReceiptOutput] = Field(default_factory=list, max_length=1000)
    message: str = Field(default="", max_length=2000)


@operation(
    "runner.complete",
    CompleteStage,
    summary="Accept one fenced terminal execution receipt.",
    public=True,
    supports_idempotency=False,
    access=ACCESS_RUNNER,
)
def complete(ctx: Context, p: CompleteStage) -> dict:
    stage = _runner_stage(ctx, p, allow_expired=True, allow_terminal=True)
    receipt = p.model_dump(mode="json", exclude={"stage_id", "fencing_token"})
    if stage.receipt is not None:
        if stage.receipt != receipt:
            raise Conflict("Stage already has a different terminal receipt.")
        return stage_result(stage)
    if stage.lease_expires_at <= timezone.now():
        raise Conflict("Stage lease expired; reconcile before completing.")
    if p.outcome == "cancelled" and stage.cancellation_requested_at is None:
        # Work that nobody asked to cancel is never labelled cancelled by a receipt.
        raise ValidationFailed("A cancelled receipt requires an earlier cancellation request.")
    if p.outcome == "succeeded":
        if stage.cancellation_requested_at or not _execution_allowed(stage.build):
            raise PermissionDenied("Successful completion is no longer authorized.")
        if p.exit_code != 0:
            raise ValidationFailed("Success requires a zero process exit code.")
    expected = {o["path"] for o in stage.build.recipe["outputs"]}
    reported = {o.path: o.sha256 for o in p.outputs}
    verified = {o.path: o.sha256 for o in stage.outputs.all()}
    if len(reported) != len(p.outputs) or reported != verified:
        raise ValidationFailed("Receipt does not match the verified output set.")
    if p.outcome == "succeeded" and set(reported) != expected:
        raise ValidationFailed("Successful receipt is missing an expected output.")
    stage.state = p.outcome
    stage.receipt = receipt
    _save(stage)
    _event(stage, "completed", outcome=p.outcome, exit_code=p.exit_code)
    return stage_result(stage)
