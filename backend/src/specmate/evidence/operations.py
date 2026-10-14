from specmate.access.permissions import Perm
from specmate.evidence.applicability import read_applicability
from specmate.evidence.contracts import (
    ListEvidence,
    ReadApplicability,
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
from specmate.evidence.subject_tests import (
    ReadSubjectTest,
    RecordSubjectTest,
    authorize_test_replay,
    read_subject_test,
    record_subject_test,
    test_scope,
)
from specmate.evidence.taxonomy import taxonomy
from specmate.operations import Context, operation
from specmate.operations.core import ACCESS_AUTHENTICATED
from specmate.operations.scope import revision_scope, workspace_scope


@operation(
    "evidence.list",
    ListEvidence,
    summary="List distinct evidence kinds with subject, method, conditions and provenance.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def evidence_list(ctx: Context, p: ListEvidence):
    return list_evidence(ctx.user, p)


@operation(
    "evidence.taxonomy",
    ReadTaxonomy,
    summary="Read the shared evidence-kind taxonomy and what each kind never establishes.",
    supports_idempotency=False,
    access=ACCESS_AUTHENTICATED,
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
    access=Perm.ITEM_CREATE,
    idempotency_scope=lambda ctx, p: revision_scope(ctx, p.revision_id, Perm.ITEM_CREATE),
)
def record_assessment(ctx: Context, p: RecordInterfaceAssessment):
    return record_interface_assessment(ctx, p)


@operation(
    "evidence.record_firmware_impact",
    RecordFirmwareImpact,
    summary="Record an immutable snapshot of one exact firmware impact comparison.",
    authorize_replay=replay_recorded,
    access=Perm.ITEM_CREATE,
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
    access=Perm.WORKSPACE_READ,
)
def read_recorded_result(ctx: Context, p: ReadRecordedResult):
    return read_recorded(ctx.user, p)


@operation(
    "evidence.record_test",
    RecordSubjectTest,
    summary="Record an immutable physical test of one exact unit or work batch.",
    authorize_replay=authorize_test_replay,
    access=Perm.INVENTORY_MANAGE,
    idempotency_scope=test_scope,
)
def record_test(ctx: Context, p: RecordSubjectTest):
    return record_subject_test(ctx, p)


@operation(
    "evidence.read_test",
    ReadSubjectTest,
    summary="Read one test record with its procedure, instruments, conditions and subject.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_test(ctx: Context, p: ReadSubjectTest):
    return read_subject_test(ctx.user, p)


@operation(
    "evidence.applicability",
    ReadApplicability,
    summary="Read evidence for a definition against one revision: exact, stale or inapplicable.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def evidence_applicability(ctx: Context, p: ReadApplicability):
    return read_applicability(ctx.user, p)
