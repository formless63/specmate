"""One resolve/capture path for GUI, API, MCP and trusted jobs (CFG-001).

Capturing records an exact design snapshot of the configuration draft plus its
canonical resolution. Defaults are converted into explicit, attributed decisions at
that moment; later option-set revisions or edits never change a captured result,
and no frozen consumer (assembly, population, firmware) is rewritten.
"""

import json

from specmate.access.permissions import Perm, authorize
from specmate.configurations.contracts import (
    CaptureResolution,
    ListResolved,
    ResolveConfiguration,
    ResolvedRef,
)
from specmate.configurations.models import ResolvedConfiguration
from specmate.configurations.queries import (
    NOT_EVALUATED,
    Reader,
    available,
    canonical,
    digest,
    parse_configuration,
    resolve,
)
from specmate.design.models import Snapshot
from specmate.design.operations import (
    CaptureDraft,
    _capture,
    authorize_snapshot,
    authorize_snapshots,
    check_state,
    scoped_draft,
)
from specmate.design.pins import pin_workspace
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord

HISTORY = 100


def constraint_summary(resolution):
    constraints = resolution.get("constraints")
    if not isinstance(constraints, dict):
        # Captured before constraint evaluation existed: nothing was evaluated.
        return {"outcome": "not_evaluated", "counts": None, "unknown": [], "invalid": []}
    results = constraints["results"]
    return {
        "outcome": constraints["outcome"],
        "counts": constraints["counts"],
        "unknown": [r["key"] for r in results if r["outcome"] == "unknown"],
        "invalid": [r["key"] for r in results if r["outcome"] == "invalid"],
    }


def configuration_draft(ctx, draft_id, permission=Perm.WORKSPACE_READ, *, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != "configuration":
        raise ValidationFailed("Select a configuration draft.")
    return draft


def summary(row):
    return {
        "resolved_configuration_id": str(row.id),
        "status": row.status,
        "snapshot_id": str(row.snapshot_id),
        "resolution_sha256": row.resolution_sha256,
        "draft_version": row.draft_version,
        "constraint_outcome": constraint_summary(row.resolution)["outcome"],
        "basis": row.basis,
        "created_at": row.created_at.isoformat(),
    }


def history(ctx, rows):
    rows = list(rows.select_related("snapshot__definition")[: HISTORY + 1])
    # Retained pins are disclosed only while their complete closure is readable.
    authorize_snapshots(ctx.user, [row.snapshot for row in rows[:HISTORY]])
    return [summary(row) for row in rows[:HISTORY]], len(rows) > HISTORY


def preview(ctx, draft):
    # Every exact pin in the draft must stay in its workspace (NotFound before any guard).
    with pin_workspace(draft.definition.workspace_id):
        return _preview(ctx, draft)


def _preview(ctx, draft):
    configuration = parse_configuration(draft.content, "configuration")
    reader = Reader(ctx.user)
    resolution = resolve(reader, configuration)
    reviewed = {
        "draft_id": str(draft.id),
        "state": draft.state_token,
        "content_sha256": digest(draft.content),
        "resolution": resolution,
    }
    return {
        **reviewed,
        "review_sha256": digest(reviewed),
        "configuration": draft.content["configuration"],
        "available": available(reader, configuration),
    }


def resolved_result(ctx, row_id, *, permission=Perm.WORKSPACE_READ):
    row = (
        ResolvedConfiguration.objects.select_related("snapshot__definition", "draft__definition")
        .filter(id=row_id)
        .first()
    )
    if row is None:
        raise NotFound("Resolved configuration unavailable.")
    authorize(ctx.user, row.workspace_id, permission)
    authorize_snapshot(ctx.user, row.snapshot)
    return row, {
        **summary(row),
        "workspace_id": str(row.workspace_id),
        "draft_id": str(row.draft_id),
        "definition_id": str(row.snapshot.definition_id),
        "snapshot_sha256": row.snapshot.sha256,
        "option_set_revision_id": str(row.option_set_revision_id),
        "review_sha256": row.review_sha256,
        "resolution": row.resolution,
    }


@operation(
    "configuration.resolve",
    ResolveConfiguration,
    summary="Resolve a configuration draft or exact snapshot deterministically for review.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def resolve_configuration(ctx: Context, p: ResolveConfiguration):
    if p.draft_id:
        draft = configuration_draft(ctx, p.draft_id)
        records, truncated = history(
            ctx, ResolvedConfiguration.objects.filter(draft=draft).order_by("-created_at")
        )
        return {**preview(ctx, draft), "resolved": records, "history_truncated": truncated}
    snapshot = Snapshot.objects.select_related("definition").filter(id=p.snapshot_id).first()
    if snapshot is None:
        raise NotFound("Configuration snapshot unavailable.")
    authorize(ctx.user, snapshot.definition.workspace_id, Perm.WORKSPACE_READ)
    if snapshot.definition.kind != "configuration":
        raise ValidationFailed("Select a configuration snapshot.")
    authorize_snapshot(ctx.user, snapshot)
    content = json.loads(bytes(snapshot.canonical))["content"]
    configuration = parse_configuration(content, "configuration")
    reader = Reader(ctx.user)
    with pin_workspace(snapshot.definition.workspace_id):
        return {
            "snapshot_id": str(snapshot.id),
            "snapshot_sha256": snapshot.sha256,
            "configuration": content["configuration"],
            "resolution": resolve(reader, configuration),
            "available": available(reader, configuration),
        }


def capture_replay(ctx, p, stored):
    configuration_draft(ctx, p.draft_id, Perm.DESIGN_EDIT)
    resolved_result(ctx, stored["resolved_configuration_id"], permission=Perm.DESIGN_EDIT)


def capture_scope(ctx, p):
    draft = configuration_draft(ctx, p.draft_id)
    scope = f"workspace:{draft.definition.workspace_id}"
    # Authorize retained outcomes before changed-payload or legacy diagnostics.
    for prior in IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user,
        operation="configuration.capture",
        key=ctx.idempotency_key,
        scope=scope,
    ):
        capture_replay(ctx, p, prior.result)
    return scope


@operation(
    "configuration.capture",
    CaptureResolution,
    summary="Capture an exact reviewed resolution as the immutable snapshot a build consumes.",
    requires_expected_state=True,
    idempotency_scope=capture_scope,
    authorize_replay=capture_replay,
    access=Perm.DESIGN_EDIT,
)
def capture(ctx: Context, p: CaptureResolution):
    draft = configuration_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    check_state(ctx, draft)
    reviewed = preview(ctx, draft)
    if reviewed["review_sha256"] != p.review_sha256:
        raise Conflict("Resolution changed; review this configuration again.")
    resolution = reviewed["resolution"]
    if resolution["status"] == "invalid":
        raise ValidationFailed("Correct invalid selections before capturing this configuration.")
    _, snapshot = _capture(ctx, CaptureDraft(draft_id=draft.id), Perm.DESIGN_EDIT)
    body = canonical(resolution)
    row = ResolvedConfiguration.objects.create(
        workspace_id=draft.definition.workspace_id,
        draft=draft,
        draft_version=draft.version,
        snapshot=snapshot,
        option_set_revision_id=resolution["option_set"]["revision_id"],
        status=resolution["status"],
        resolution=resolution,
        resolution_canonical=body,
        resolution_sha256=digest(resolution),
        review_sha256=p.review_sha256,
        basis=p.basis,
        created_by=ctx.user,
    )
    return {**summary(row), "snapshot_sha256": snapshot.sha256, "resolution": resolution}


@operation(
    "configuration.read_resolved",
    ResolvedRef,
    summary="Read an immutable resolved configuration under current authority.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_resolved(ctx: Context, p: ResolvedRef):
    return resolved_result(ctx, p.resolved_configuration_id)[1]


@operation(
    "configuration.build_input",
    ResolvedRef,
    summary="Exact resolved inputs for a build; incomplete resolutions are refused.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def build_input(ctx: Context, p: ResolvedRef):
    row, result = resolved_result(ctx, p.resolved_configuration_id)
    resolution = result["resolution"]
    if row.status != "complete":
        unresolved = [
            d["option_key"] for d in resolution["decisions"] if d["status"] == "unresolved"
        ]
        raise ValidationFailed(
            "This resolved configuration has unresolved required choices.",
            details={"unresolved": unresolved},
        )
    constraints = constraint_summary(resolution)
    if constraints["outcome"] == "invalid":
        # Recording an invalid outcome is allowed; building from it is not.
        raise ValidationFailed(
            "This resolved configuration violates declared constraints.",
            details={"invalid": constraints["invalid"]},
        )
    pins = sorted(
        (
            {"revision_id": str(dep.revision_id), "sha256": dep.revision.snapshot.sha256}
            for dep in row.snapshot.dependencies.select_related("revision__snapshot")
        ),
        key=lambda item: item["revision_id"],
    )
    return {
        "resolved_configuration_id": result["resolved_configuration_id"],
        "snapshot_id": result["snapshot_id"],
        "snapshot_sha256": result["snapshot_sha256"],
        "resolution_sha256": result["resolution_sha256"],
        "option_set_revision_id": result["option_set_revision_id"],
        "pins": pins,
        "choices": [
            {
                "option_key": d["option_key"],
                "domain": d["domain"],
                "path": d["path"],
                "status": d["status"],
                "source": d["source"],
                "revision_id": d["choice"]["revision"]["revision_id"]
                if d["choice"] and d["choice"]["revision"]
                else None,
                "population_option_id": (d["choice"] or {}).get("population_option_id"),
                "value": d["choice"]["value"] if d["choice"] else None,
            }
            for d in resolution["decisions"]
        ],
        # Invalid is refused above; unknown and not-evaluated travel with the snapshot.
        "constraints": constraints,
        **NOT_EVALUATED,
    }


@operation(
    "configuration.list_resolved",
    ListResolved,
    summary="List the latest resolved configurations of a workspace for selection.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def list_resolved(ctx: Context, p: ListResolved):
    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_READ)
    rows = ResolvedConfiguration.objects.filter(workspace=workspace).select_related("snapshot")
    summaries, truncated = history(ctx, rows.order_by("-created_at", "-id"))
    return {"workspace_id": str(workspace.id), "resolved": summaries, "truncated": truncated}
