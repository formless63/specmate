"""Actual-subject test records (EVD-002).

A test record names the procedure, instruments, conditions and the exact thing tested:
one physical unit, or one work batch as a whole. Evidence about unit A never reads as
evidence about unit B of the same design revision, lot or batch; a batch test never reads
as a test of its individual units. An optional resolved configuration states which exact
configuration the subject was tested as. Records are immutable and append-only.
Unknown calibration, conditions and sample size stay unknown, never defaulted.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from django.db import transaction
from pydantic import Field, StringConstraints, model_validator

from specmate.access.permissions import Perm, authorize
from specmate.evidence.contracts import StrictModel
from specmate.evidence.models import SubjectTest
from specmate.facts.contracts import Condition, Key, Value
from specmate.operations import Context, NotFound, OperationError, ValidationFailed

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
FINDING_TEXT = {
    "criterion_met": "criterion met",
    "criterion_not_met": "criterion not met",
    "inconclusive": "inconclusive",
}


class Instrument(StrictModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    identifier: Annotated[str, StringConstraints(min_length=1, max_length=200)] | None = None
    calibration: Literal["unknown", "calibrated", "uncalibrated"] = "unknown"
    calibration_reference: (
        Annotated[str, StringConstraints(min_length=1, max_length=500)] | None
    ) = None

    @model_validator(mode="after")
    def coherent(self):
        if (self.calibration == "calibrated") != (self.calibration_reference is not None):
            raise ValueError("A calibrated instrument needs a calibration reference, and only it.")
        return self


class UnitSubject(StrictModel):
    kind: Literal["physical_unit"]
    unit_id: UUID


class BatchSubject(StrictModel):
    kind: Literal["work_batch"]
    work_batch_id: UUID
    # Units actually tested; omitted means unknown.
    sample_size: Annotated[int, Field(ge=1, le=1_000_000)] | None = None


class RecordSubjectTest(StrictModel):
    subject: Annotated[UnitSubject | BatchSubject, Field(discriminator="kind")]
    configuration_id: UUID | None = None
    test_kind: Key
    procedure: Text
    instruments: list[Instrument] = Field(min_length=1, max_length=20)
    conditions: list[Condition] = Field(default_factory=list, max_length=30)
    observed_at: datetime
    criterion: Text
    finding: Literal["criterion_met", "criterion_not_met", "inconclusive"]
    value: Value | None = None
    summary: Annotated[str, StringConstraints(max_length=2000)] = ""
    note: Annotated[str, StringConstraints(max_length=2000)] = ""

    @model_validator(mode="after")
    def coherent(self):
        if self.observed_at.tzinfo is None:
            raise ValueError("Observation time requires a timezone.")
        properties = [c.property for c in self.conditions]
        if len(properties) != len(set(properties)):
            raise ValueError("Condition properties must be unique.")
        return self


class ReadSubjectTest(StrictModel):
    test_id: UUID


def resolve_subject(user, subject, permission):
    """(workspace_id, design revision, unit, batch) under current authority."""
    from specmate.inventory.queries import get_work_batch
    from specmate.physical_units.queries import get_unit

    if subject.kind == "physical_unit":
        unit = get_unit(user, subject.unit_id)
        authorize(user, unit.workspace_id, permission)
        return unit.workspace_id, unit.revision, unit, None
    batch = get_work_batch(user, subject.work_batch_id)
    workspace_id = batch.revision.definition.workspace_id
    authorize(user, workspace_id, permission)
    return workspace_id, batch.revision, None, batch


def resolve_configuration(user, configuration_id, workspace_id):
    if configuration_id is None:
        return None
    from specmate.configurations.models import ResolvedConfiguration
    from specmate.configurations.operations import resolved_result

    if not ResolvedConfiguration.objects.filter(
        id=configuration_id, workspace_id=workspace_id
    ).exists():
        raise NotFound("Resolved configuration unavailable.")
    ctx = Context(user=user, via="internal", request_id="subject-test")
    row, _ = resolved_result(ctx, configuration_id)
    return row


def test_scope(ctx, p):
    from specmate.operations.scope import workspace_scope

    workspace_id, *_ = resolve_subject(ctx.user, p.subject, Perm.INVENTORY_MANAGE)
    return workspace_scope(ctx, workspace_id, Perm.INVENTORY_MANAGE)


def authorize_test_replay(ctx, p, stored):
    workspace_id, *_ = resolve_subject(ctx.user, p.subject, Perm.INVENTORY_MANAGE)
    resolve_configuration(ctx.user, p.configuration_id, workspace_id)


def record_subject_test(ctx: Context, p: RecordSubjectTest):
    workspace_id, revision, unit, batch = resolve_subject(
        ctx.user, p.subject, Perm.INVENTORY_MANAGE
    )
    configuration = resolve_configuration(ctx.user, p.configuration_id, workspace_id)
    if p.finding != "inconclusive" and any(i.calibration == "uncalibrated" for i in p.instruments):
        raise ValidationFailed(
            "A test using an instrument recorded as uncalibrated can only be inconclusive."
        )
    with transaction.atomic():
        row = SubjectTest.objects.create(
            workspace_id=workspace_id,
            subject_kind=p.subject.kind,
            unit=unit,
            work_batch=batch,
            sample_size=getattr(p.subject, "sample_size", None),
            design_revision=revision,
            configuration=configuration,
            test_kind=p.test_kind,
            procedure=p.procedure,
            instruments=[i.model_dump(mode="json") for i in p.instruments],
            conditions=[c.model_dump(mode="json") for c in p.conditions],
            criterion=p.criterion,
            finding=p.finding,
            value=p.value.model_dump(mode="json") if p.value else None,
            summary=p.summary,
            observed_at=p.observed_at,
            note=p.note,
            recorded_by=ctx.user,
            request_id=ctx.request_id,
        )
    return test_view(row)


def test_view(row):
    return {
        "test_id": str(row.id),
        "workspace_id": str(row.workspace_id),
        "subject": {
            "kind": row.subject_kind,
            "id": str(row.unit_id or row.work_batch_id),
            "sample_size": row.sample_size,
        },
        "design_revision_id": str(row.design_revision_id),
        "configuration_id": str(row.configuration_id) if row.configuration_id else None,
        "test_kind": row.test_kind,
        "procedure": row.procedure,
        "instruments": row.instruments,
        "conditions": row.conditions,
        "criterion": row.criterion,
        "finding": row.finding,
        "value": row.value,
        "summary": row.summary,
        "note": row.note,
        "observed_at": row.observed_at.isoformat(),
        "recorded_at": row.recorded_at.isoformat(),
        "recorded_by_id": row.recorded_by_id,
        "applies_to": "this_subject_only",
        "physical_qualification": False,
    }


def readable_test(user, row):
    """The row when the user holds current authority over its subject and configuration."""
    from specmate.inventory.queries import get_work_batch
    from specmate.physical_units.queries import get_unit

    authorize(user, row.workspace_id, Perm.WORKSPACE_READ)
    if row.unit_id:
        get_unit(user, row.unit_id)
    else:
        get_work_batch(user, row.work_batch_id)
    if row.configuration_id:
        resolve_configuration(user, row.configuration_id, row.workspace_id)
    return row


def read_subject_test(user, p: ReadSubjectTest):
    row = SubjectTest.objects.select_related("unit", "work_batch").filter(id=p.test_id).first()
    if row is None:
        raise NotFound("Test record unavailable.")
    try:
        readable_test(user, row)
    except OperationError:
        raise NotFound("Test record unavailable.") from None
    return test_view(row)


def value_line(value):
    from specmate.evidence.queries import value_text

    return value_text(value)


def evidence_item(row, describe):
    """Map one test record onto the shared evidence item shape."""
    names = ", ".join(i["name"] for i in row.instruments)
    references = [f"test:{row.id}", f"revision:{row.design_revision_id}"]
    warnings = []
    for instrument in row.instruments:
        label = instrument["name"] + (
            f" ({instrument['identifier']})" if instrument.get("identifier") else ""
        )
        if instrument["calibration"] == "calibrated":
            references.append(
                f"instrument:{label}; calibration {instrument['calibration_reference']}"
            )
        else:
            references.append(f"instrument:{label}; calibration {instrument['calibration']}")
            warnings.append(f"Calibration of {instrument['name']} is {instrument['calibration']}.")
    if row.unit_id:
        subject = {
            "scope": "actual",
            "kind": "physical_unit",
            "id": row.unit_id,
            "label": f"Physical unit {row.unit.serial}",
        }
        warnings.append(
            f"Applies to unit {row.unit.serial} only; other units of the same design revision, "
            "lot or batch are not covered."
        )
        extra = ["Behavior of any other unit, including others of the same design revision."]
    else:
        subject = {
            "scope": "actual",
            "kind": "work_batch",
            "id": row.work_batch_id,
            "label": f"Work batch {row.work_batch.label} (as a whole)",
        }
        tested = (
            f"{row.sample_size} unit(s) tested" if row.sample_size else "sample size not stated"
        )
        warnings.append(
            f"Applies to this batch as a whole ({tested}); it does not qualify any individual "
            "unit in it."
        )
        extra = ["Behavior of any individual unit in the batch."]
    if row.configuration_id:
        references.append(f"configuration:{row.configuration_id}")
        extra.append("Behavior under any other configuration.")
    else:
        warnings.append(
            "No resolved configuration is recorded; the tested configuration is unknown."
        )
    statement = f"{row.test_kind} test, {FINDING_TEXT[row.finding]}: {row.criterion}"
    if row.value:
        statement += f" (observed {value_line(row.value)})"
    return {
        **describe("physical_measurement", extra),
        "evidence_id": f"test:{row.id}",
        "source": "subject_tests",
        "workspace_id": row.workspace_id,
        "subject": subject,
        "statement": statement,
        "status": row.finding,
        "conditions": [
            {"property": c["property"], "status": c["status"], "value": c.get("value")}
            for c in row.conditions
        ],
        "method": {
            "name": f"{row.test_kind}_test",
            "procedure": row.procedure,
            "instrument": names,
        },
        "basis": {
            "origin": "test_record",
            "references": references,
            "independently_verified": False,
        },
        "recorded_at": row.recorded_at.isoformat(),
        "observed_at": row.observed_at.isoformat(),
        "actor_id": row.recorded_by_id,
        "warnings": warnings,
    }
