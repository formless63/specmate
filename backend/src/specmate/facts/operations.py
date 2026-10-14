import hashlib
import json

from specmate.access.models import Workspace
from specmate.access.permissions import Perm
from specmate.design.operations import canonical_bytes
from specmate.facts.contracts import AppendFact, PhysicalUnitTarget, ReadFacts, RegisterSubject
from specmate.facts.models import AssertionInput, AssertionSource, FactAssertion, FactSubject
from specmate.facts.queries import (
    MAX_ASSERTIONS,
    assertion_result,
    canonical_conditions,
    canonical_value,
    group_key,
    read_facts,
    resolve_target,
    subject_result,
    subject_target,
    subject_with_assertions,
    validate_evidence,
)
from specmate.operations import Conflict, Context, ValidationFailed, operation
from specmate.operations.scope import workspace_scope
from specmate.releases.warnings import raise_for_assertion


def target_write_permission(target):
    return Perm.INVENTORY_MANAGE if isinstance(target, PhysicalUnitTarget) else Perm.ITEM_CREATE


def registration_scope(ctx, p):
    permission = target_write_permission(p.target)
    fields = resolve_target(ctx.user, p.target, permission)
    return workspace_scope(ctx, fields["workspace"].id, permission)


def assertion_scope(ctx, p):
    subject, _ = subject_with_assertions(ctx.user, p.subject_id, Perm.ITEM_CREATE)
    permission = target_write_permission(subject_target(subject))
    return workspace_scope(ctx, subject.workspace_id, permission)


def authorize_registration_replay(ctx, p, stored):
    resolve_target(ctx.user, p.target, target_write_permission(p.target))
    subject_with_assertions(ctx.user, stored["subject_id"], Perm.ITEM_CREATE)


def authorize_append_replay(ctx, p, stored):
    subject_with_assertions(ctx.user, p.subject_id, Perm.ITEM_CREATE)
    validate_evidence(ctx.user, p.fact)


@operation(
    "facts.register_subject",
    RegisterSubject,
    summary="Resolve an engineering identity and register its fact ledger.",
    idempotency_scope=registration_scope,
    authorize_replay=authorize_registration_replay,
    access=Perm.ITEM_CREATE,
)
def register_subject(ctx: Context, p: RegisterSubject):
    fields = resolve_target(ctx.user, p.target, target_write_permission(p.target))
    fingerprint = hashlib.sha256(canonical_bytes(p.target.model_dump(mode="json"))).hexdigest()
    # Serialize identity registration per workspace, without changing its state.
    Workspace.objects.select_for_update().get(id=fields["workspace"].id)
    subject, _ = FactSubject.objects.get_or_create(
        workspace=fields.pop("workspace"),
        fingerprint=fingerprint,
        defaults={**fields, "registered_by": ctx.user},
    )
    subject, _ = subject_with_assertions(ctx.user, subject.id, Perm.ITEM_CREATE)
    return subject_result(subject)


@operation(
    "facts.append",
    AppendFact,
    summary="Append an immutable scoped assertion without replacing prior evidence.",
    requires_expected_state=True,
    idempotency_scope=assertion_scope,
    authorize_replay=authorize_append_replay,
    access=Perm.ITEM_CREATE,
)
def append_fact(ctx: Context, p: AppendFact):
    subject, rows = subject_with_assertions(ctx.user, p.subject_id, Perm.ITEM_CREATE, lock=True)
    if ctx.require_expected_state() != subject.state_token:
        raise Conflict("Fact ledger changed.", details={"current_state": subject.state_token})
    if len(rows) >= MAX_ASSERTIONS:
        raise ValidationFailed("Fact ledger exceeds the supported limit.")
    if p.fact.provenance.method == "measurement" and subject.kind != "physical_unit":
        raise ValidationFailed(
            "A physical measurement attaches only to an actual physical unit; "
            "record a design-scope value as a source claim, review or calculation."
        )
    sources, inputs = validate_evidence(ctx.user, p.fact)
    if p.fact.status == "conflicting":
        context = {
            "purpose": p.fact.purpose,
            "role": p.fact.role,
            "conditions": canonical_conditions(p.fact),
        }
        for candidate in inputs:
            if (
                candidate.subject_id != subject.id
                or candidate.property != p.fact.property
                or candidate.status != "known"
                or group_key(candidate) != json.dumps(context, sort_keys=True)
            ):
                raise ValidationFailed("Conflict inputs must address the same subject and context.")
        if len(inputs) < 2:
            raise ValidationFailed("Conflict requires two distinct assertions.")
    assertion = FactAssertion.objects.create(
        subject=subject,
        sequence=subject.version,
        property=p.fact.property,
        status=p.fact.status,
        method=p.fact.provenance.method,
        content=p.fact.model_dump(mode="json"),
        canonical_value=canonical_value(p.fact.value),
        canonical_conditions=canonical_conditions(p.fact),
        actor=ctx.user,
        request_id=ctx.request_id,
    )
    AssertionSource.objects.bulk_create(
        AssertionSource(assertion=assertion, source_file=source) for source in sources
    )
    AssertionInput.objects.bulk_create(
        AssertionInput(assertion=assertion, input_assertion=source) for source in inputs
    )
    subject.version += 1
    subject.save(update_fields=["version"])
    # A new contradiction on a revision a release pins warns that release (EVD-005).
    raise_for_assertion(subject, rows, assertion)
    return {**subject_result(subject), "assertion": assertion_result(assertion)}


@operation(
    "facts.read",
    ReadFacts,
    summary="Inspect facts, unknowns and all conflicting candidates.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def inspect_facts(ctx: Context, p: ReadFacts):
    return read_facts(ctx.user, p.subject_id, p.property, offset=p.offset, limit=p.limit)
