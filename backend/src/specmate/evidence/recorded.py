"""Explicitly recorded, immutable snapshots of derived results (EVD-001).

Interface assessments and firmware impact reviews are computed live from exact frozen
inputs; nothing is recorded on read. A deliberate record operation stores the result as
computed, its hash, its exact input revision pins and the recording actor. A record is
never rewritten. When a pinned input definition later gains a newer revision, the record
reads as stale; its stored result and pins stay exactly as recorded.

Every workspace member reads everything in the workspace, and database guards keep pins
inside the record workspace, so reading a record needs only workspace.read. Idempotent
replay of a record command re-resolves the exact inputs through the owning module.
"""

import hashlib
from uuid import UUID

from django.db import transaction
from django.db.models import Max

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Revision
from specmate.design.operations import canonical_bytes
from specmate.evidence.contracts import (
    ReadRecordedResult,
    RecordFirmwareImpact,
    RecordInterfaceAssessment,
)
from specmate.evidence.contracts import (
    RecordedResult as RecordedResultView,
)
from specmate.evidence.models import RecordedPin, RecordedResult
from specmate.firmware_impact.contracts import CompareImpact
from specmate.operations import Conflict, Context, NotFound, OperationError, ValidationFailed

INTERFACE_ALGORITHM = "interface_assessment/0.1"
FIRMWARE_ALGORITHM = "firmware_impact/1"
KIND = "generated_check"


def digest(value) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def assessment_inputs(user, revision_id):
    """The exact assessment revision and its closure, under current authority."""
    from specmate.interfaces.contracts import InterfaceAssessment
    from specmate.interfaces.queries import read_revision

    revision, closure = read_revision(user, revision_id)
    if not isinstance(closure.root, InterfaceAssessment):
        raise ValidationFailed("Only an interface assessment revision can be recorded here.")
    return revision, closure


def assessment_pins(revision, closure):
    root = closure.root
    roles = {
        root.left_pinout_revision_id: "left_pinout",
        root.right_pinout_revision_id: "right_pinout",
    }
    pins = [("assessment", revision.id)]
    pins += [(roles.get(rid, "dependency"), rid) for rid in sorted(closure.revisions, key=str)]
    return pins


def firmware_pins(result):
    pins = []
    for side in ("baseline", "candidate"):
        inputs = result[side]["inputs"]
        pins.append((f"{side}_firmware", UUID(inputs["firmware_revision_id"])))
        population = inputs.get("target", {}).get("population_revision_id")
        if population:
            pins.append((f"{side}_population", UUID(population)))
        occurrence = inputs.get("occurrence")
        if occurrence:
            assembly = Revision.objects.filter(
                snapshot_id=occurrence["assembly_snapshot_id"]
            ).first()
            if assembly is not None:
                pins.append((f"{side}_assembly", assembly.id))
    return pins


def store(ctx, workspace_id, source, request, result, result_sha256, algorithm, note, pins):
    with transaction.atomic():
        record = RecordedResult.objects.create(
            workspace_id=workspace_id,
            source=source,
            request=request,
            result=result,
            result_sha256=result_sha256,
            algorithm_version=algorithm,
            note=note,
            recorded_by=ctx.user,
            request_id=ctx.request_id,
        )
        unique = list(dict.fromkeys(pins))
        RecordedPin.objects.bulk_create(
            RecordedPin(record=record, role=role, revision_id=rid) for role, rid in unique
        )
    return view(record)


def record_interface_assessment(ctx: Context, p: RecordInterfaceAssessment):
    from specmate.interfaces.queries import inspect_revision

    revision, closure = assessment_inputs(ctx.user, p.revision_id)
    workspace = authorize(ctx.user, revision.definition.workspace_id, Perm.ITEM_CREATE)
    result = inspect_revision(ctx.user, revision.id)
    return store(
        ctx,
        workspace.id,
        RecordedResult.Source.INTERFACE_ASSESSMENT,
        p.model_dump(mode="json", exclude={"note"}),
        result,
        digest(result),
        INTERFACE_ALGORITHM,
        p.note,
        assessment_pins(revision, closure),
    )


def record_firmware_impact(ctx: Context, p: RecordFirmwareImpact):
    from specmate.firmware_impact.operations import compare

    workspace = authorize(ctx.user, p.comparison.workspace_id, Perm.ITEM_CREATE)
    result = compare(ctx, p.comparison)
    if (
        p.expected_comparison_sha256 is not None
        and result["comparison_sha256"] != p.expected_comparison_sha256
    ):
        raise Conflict(
            "The current comparison differs from the one shown; review it again before recording.",
            details={"comparison_sha256": result["comparison_sha256"]},
        )
    return store(
        ctx,
        workspace.id,
        RecordedResult.Source.FIRMWARE_IMPACT,
        p.comparison.model_dump(mode="json"),
        result,
        result["comparison_sha256"],
        FIRMWARE_ALGORITHM,
        p.note,
        firmware_pins(result),
    )


def authorize_inputs(user, record):
    """Full current authority over every exact input; used where a replay depends on it."""
    authorize(user, record.workspace_id, Perm.WORKSPACE_READ)
    if record.source == RecordedResult.Source.INTERFACE_ASSESSMENT:
        assessment_inputs(user, record.request["revision_id"])
    else:
        from specmate.firmware_impact.operations import authorized_inputs

        authorized_inputs(
            Context(user=user, via="internal", request_id="recorded-read"),
            CompareImpact.model_validate(record.request),
        )


def pin_states(records):
    """Pins of each record with the newest revision number of each pinned definition."""
    pins = list(
        RecordedPin.objects.filter(record__in=records)
        .select_related("revision")
        .order_by("record_id", "role", "revision_id")
    )
    definitions = {pin.revision.definition_id for pin in pins}
    latest = dict(
        Revision.objects.filter(definition_id__in=definitions)
        .values("definition_id")
        .annotate(latest=Max("number"))
        .values_list("definition_id", "latest")
    )
    states = {}
    for pin in pins:
        newest = latest[pin.revision.definition_id]
        states.setdefault(pin.record_id, []).append(
            {
                "role": pin.role,
                "revision_id": pin.revision_id,
                "definition_id": pin.revision.definition_id,
                "number": pin.revision.number,
                "latest_number": newest,
                "newer_revision_exists": newest > pin.revision.number,
            }
        )
    return states


def newer_assertions(record):
    """Whether fact assertions arrived in a firmware record's scope after it was recorded.

    The scope is the one the comparison itself used (exact baseline revision subjects and
    contexts plus the deliberately selected assertions). Only a boolean is derived; nothing
    stored is touched. None for sources that carry no assertion scope.
    """
    if record.source != RecordedResult.Source.FIRMWARE_IMPACT:
        return None
    from specmate.facts.models import FactAssertion
    from specmate.firmware_impact.operations import scope_filter

    request = CompareImpact.model_validate(record.request)
    population = record.result["baseline"]["inputs"].get("target", {}).get("population_revision_id")
    scope = scope_filter(record.workspace_id, request.baseline, population, request.assertion_ids)
    return FactAssertion.objects.filter(scope, recorded_at__gt=record.recorded_at).exists()


def view(record, pins=None):
    if pins is None:
        pins = pin_states([record]).get(record.id, [])
    fresh = newer_assertions(record)
    return RecordedResultView(
        record_id=record.id,
        workspace_id=record.workspace_id,
        source=record.source,
        kind=KIND,
        algorithm_version=record.algorithm_version,
        request=record.request,
        result=record.result,
        result_sha256=record.result_sha256,
        note=record.note,
        recorded_at=record.recorded_at.isoformat(),
        recorded_by_id=record.recorded_by_id,
        pins=pins,
        stale=any(pin["newer_revision_exists"] for pin in pins) or bool(fresh),
        newer_assertions=fresh,
    ).model_dump(mode="json")


def read_recorded(user, p: ReadRecordedResult):
    record = RecordedResult.objects.filter(id=p.record_id).first()
    if record is None:
        raise NotFound("Recorded result unavailable.")
    try:
        authorize(user, record.workspace_id, Perm.WORKSPACE_READ)
    except OperationError:
        # Missing and foreign records read alike.
        raise NotFound("Recorded result unavailable.") from None
    return view(record)


def observation_range(result):
    """'N-M of T' when a firmware record holds only part of its observations, else None."""
    shown, total = len(result["observations"]), result["observations_total"]
    if shown >= total:
        return None
    first = result["observation_offset"] + 1
    return f"{first}\u2013{first + shown - 1} of {total}" if shown else f"none of {total}"
