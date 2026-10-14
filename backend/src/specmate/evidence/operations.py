from specmate.access.permissions import Perm
from specmate.evidence.contracts import (
    ListEvidence,
    ReadRecordedResult,
    ReadTaxonomy,
    RecordFirmwareImpact,
    RecordInterfaceAssessment,
)
from specmate.evidence.queries import list_evidence
from specmate.evidence.recorded import (
    authorize_inputs,
    read_recorded,
    record_firmware_impact,
    record_interface_assessment,
)
from specmate.evidence.taxonomy import taxonomy
from specmate.operations import Context, operation
from specmate.operations.scope import revision_scope, workspace_scope


@operation(
    "evidence.list",
    ListEvidence,
    summary="List distinct evidence kinds with subject, method, conditions and provenance.",
    supports_idempotency=False,
)
def evidence_list(ctx: Context, p: ListEvidence):
    return list_evidence(ctx.user, p)


@operation(
    "evidence.taxonomy",
    ReadTaxonomy,
    summary="Read the shared evidence-kind taxonomy and what each kind never establishes.",
    supports_idempotency=False,
)
def evidence_taxonomy(ctx: Context, p: ReadTaxonomy):
    return taxonomy()


def replay_recorded(ctx, p, stored):
    # A replay returns the retained record as a fresh command result; re-check current
    # authority over its exact inputs as the original command did.
    from specmate.evidence.models import RecordedResult
    from specmate.operations import NotFound, OperationError

    record = RecordedResult.objects.filter(id=stored["record_id"]).first()
    if record is None:
        raise NotFound("Recorded result unavailable.")
    try:
        authorize_inputs(ctx.user, record)
    except OperationError:
        raise NotFound("Recorded result unavailable.") from None


@operation(
    "evidence.record_interface_assessment",
    RecordInterfaceAssessment,
    summary="Record an immutable snapshot of one exact interface assessment result.",
    authorize_replay=replay_recorded,
    idempotency_scope=lambda ctx, p: revision_scope(ctx, p.revision_id, Perm.ITEM_CREATE),
)
def record_assessment(ctx: Context, p: RecordInterfaceAssessment):
    return record_interface_assessment(ctx, p)


@operation(
    "evidence.record_firmware_impact",
    RecordFirmwareImpact,
    summary="Record an immutable snapshot of one exact firmware impact comparison.",
    authorize_replay=replay_recorded,
    idempotency_scope=lambda ctx, p: workspace_scope(
        ctx, p.comparison.workspace_id, Perm.ITEM_CREATE
    ),
)
def record_impact(ctx: Context, p: RecordFirmwareImpact):
    return record_firmware_impact(ctx, p)


@operation(
    "evidence.read_recorded",
    ReadRecordedResult,
    summary="Read one recorded result with its exact pins and current staleness.",
    supports_idempotency=False,
)
def read_recorded_result(ctx: Context, p: ReadRecordedResult):
    return read_recorded(ctx.user, p)
