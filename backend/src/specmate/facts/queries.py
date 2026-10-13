"""Resolved identities, complete evidence authority and non-destructive fact assessments."""

import json
from collections import defaultdict
from decimal import Decimal

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import get_snapshot, resolve_occurrence
from specmate.design.models import Definition
from specmate.facts.contracts import (
    AssertionEvidence,
    DefinitionTarget,
    NumericValue,
    OccurrenceTarget,
    ProjectTarget,
    RevisionTarget,
    SourceFileEvidence,
)
from specmate.facts.models import FactAssertion, FactSubject
from specmate.operations import NotFound, ValidationFailed
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.models import SourceBundleFile

MAX_ASSERTIONS = 5000
MAX_EVIDENCE_CLOSURE = 5000


def resolve_target(user, target, permission=Perm.PROJECT_READ):
    fields = {"kind": target.kind, "feature_id": getattr(target, "feature_id", None)}
    if isinstance(target, ProjectTarget):
        project_id = target.project_id
    elif isinstance(target, DefinitionTarget):
        definition = Definition.objects.filter(id=target.definition_id).first()
        if definition is None:
            raise NotFound("Subject unavailable.")
        project_id = definition.project_id
        fields["definition"] = definition
    elif isinstance(target, RevisionTarget):
        revision = get_revision(user, target.revision_id)
        project_id = revision.definition.project_id
        fields["revision"] = revision
    else:
        snapshot, _ = get_snapshot(user, target.snapshot_id)
        resolve_occurrence(user, target.snapshot_id, target.path, target.feature_id)
        project_id = snapshot.definition.project_id
        fields.update(snapshot=snapshot, path=target.path)
    fields["project"] = authorize(user, project_id, permission)
    return fields


def subject_target(subject):
    if subject.kind == "project":
        return ProjectTarget(kind="project", project_id=subject.project_id)
    if subject.kind == "definition":
        return DefinitionTarget(
            kind="definition", definition_id=subject.definition_id, feature_id=subject.feature_id
        )
    if subject.kind == "revision":
        return RevisionTarget(
            kind="revision", revision_id=subject.revision_id, feature_id=subject.feature_id
        )
    return OccurrenceTarget(
        kind="occurrence",
        snapshot_id=subject.snapshot_id,
        path=subject.path,
        feature_id=subject.feature_id,
    )


def source_file(user, source):
    revision = get_bundle_revision(user, source.bundle_revision_id)
    file = (
        SourceBundleFile.objects.select_related("blob", "revision__bundle")
        .filter(revision=revision, path=source.path)
        .first()
    )
    if file is None:
        raise NotFound("Evidence unavailable.")
    return file


def authorize_assertions(user, assertions):
    pending = list(assertions)
    visited = set()
    while pending:
        assertion = pending.pop()
        if assertion.id in visited:
            continue
        if len(visited) >= MAX_EVIDENCE_CLOSURE:
            raise ValidationFailed("Evidence closure exceeds the supported limit.")
        visited.add(assertion.id)
        authorize(user, assertion.subject.project_id, Perm.PROJECT_READ)
        resolve_target(user, subject_target(assertion.subject))
        for link in assertion.source_links.select_related("source_file__revision__bundle"):
            authorize(user, link.source_file.revision.bundle.project_id, Perm.PROJECT_READ)
        pending.extend(
            link.input_assertion
            for link in assertion.input_links.select_related("input_assertion__subject")
        )


def subject_with_assertions(user, subject_id, permission=Perm.PROJECT_READ, *, lock=False):
    query = FactSubject.objects
    if lock:
        query = query.select_for_update()
    subject = query.filter(id=subject_id).first()
    if subject is None:
        raise NotFound("Subject unavailable.")
    authorize(user, subject.project_id, permission)
    resolve_target(user, subject_target(subject), permission)
    assertions = list(subject.assertions.select_related("subject").order_by("sequence"))
    authorize_assertions(user, assertions)
    if len(assertions) > MAX_ASSERTIONS:
        raise ValidationFailed("Fact ledger exceeds the supported limit.")
    return subject, assertions


def validate_evidence(user, fact):
    sources, inputs = {}, {}
    for source in fact.provenance.evidence:
        if isinstance(source, SourceFileEvidence):
            file = source_file(user, source)
            sources[file.pk] = file
        elif isinstance(source, AssertionEvidence):
            assertion = (
                FactAssertion.objects.select_related("subject")
                .filter(id=source.assertion_id)
                .first()
            )
            if assertion is None:
                raise NotFound("Evidence unavailable.")
            inputs[assertion.id] = assertion
    authorize_assertions(user, inputs.values())
    return list(sources.values()), list(inputs.values())


def canonical_value(value):
    if value is None:
        return None
    if isinstance(value, NumericValue):
        return value.canonical()
    return value.model_dump(mode="json")


def canonical_conditions(fact):
    return [
        {
            "property": condition.property,
            "status": condition.status,
            "value": canonical_value(condition.value),
        }
        for condition in sorted(fact.conditions, key=lambda c: c.property)
    ]


def subject_result(subject):
    return {
        "subject_id": str(subject.id),
        "project_id": str(subject.project_id),
        "target": subject_target(subject).model_dump(mode="json"),
        "state": subject.state_token,
        "feature_status": "not_evaluated" if subject.feature_id else "not_applicable",
    }


def assertion_result(assertion):
    return {
        "assertion_id": str(assertion.id),
        "subject_id": str(assertion.subject_id),
        "sequence": assertion.sequence,
        "fact": assertion.content,
        "canonical_value": assertion.canonical_value,
        "canonical_conditions": assertion.canonical_conditions,
        "recorded_at": assertion.recorded_at.isoformat(),
        "evidence_status": "declared",
        "relation_to_design_state": "attached_evidence",
        "actor_id": str(assertion.actor_id),
        "source_files": [
            {
                "bundle_revision_id": str(link.source_file.revision_id),
                "path": link.source_file.path,
                "sha256": link.source_file.blob.sha256,
                "rights": link.source_file.rights,
            }
            for link in assertion.source_links.select_related("source_file__blob")
        ],
    }


def group_key(assertion):
    content = assertion.content
    return json.dumps(
        {
            "purpose": content["purpose"],
            "role": content["role"],
            "conditions": assertion.canonical_conditions,
        },
        sort_keys=True,
    )


def incompatible_candidates(known):
    values = [row.canonical_value for row in known]
    if not values:
        return False
    if all(value["kind"] in {"quantity", "range"} for value in values):
        if len({value["dimension"] for value in values}) > 1:
            return True
        # Intervals in one dimension have a common intersection iff no pair is
        # disjoint. The extrema check avoids a quadratic scan of large histories.
        lower = max(Decimal(value.get("lower", value.get("magnitude"))) for value in values)
        upper = min(Decimal(value.get("upper", value.get("magnitude"))) for value in values)
        return lower > upper
    return len({json.dumps(value, sort_keys=True) for value in values}) > 1


def assessments(assertions, property_name):
    groups = defaultdict(list)
    for assertion in assertions:
        if assertion.property == property_name:
            groups[group_key(assertion)].append(assertion)
    result = []
    for key, records in groups.items():
        known = [row for row in records if row.status == "known"]
        declared = {row.status for row in records}
        conflict = (
            "conflicting" in declared
            or {"known", "not_applicable"} <= declared
            or incompatible_candidates(known)
        )
        if conflict:
            status = "conflicting"
        elif "unknown" in declared:
            status = "unknown"
        elif "not_evaluated" in declared:
            status = "not_evaluated"
        elif known:
            status = "known"
        else:
            status = "not_applicable"
        # Equal canonical values can be displayed once. Otherwise preserve all candidates;
        # an overlap or a later timestamp never chooses a winning assertion.
        values = {json.dumps(row.canonical_value, sort_keys=True) for row in known}
        value = known[0].canonical_value if status == "known" and len(values) == 1 else None
        result.append(
            {
                **json.loads(key),
                "status": status,
                "value": value,
                "assertion_ids": [str(row.id) for row in records],
            }
        )
    return result or [
        {
            "status": "unknown",
            "value": None,
            "assertion_ids": [],
            "reason": "No assertion records this property.",
        }
    ]


def read_facts(user, subject_id, property_name=None, *, offset=0, limit=50):
    subject, rows = subject_with_assertions(user, subject_id)
    selected = [row for row in rows if property_name is None or row.property == property_name]
    properties = (
        sorted({row.property for row in rows}) if property_name is None else [property_name]
    )
    return {
        **subject_result(subject),
        "assertions": [assertion_result(row) for row in selected[offset : offset + limit]],
        "assessments": {name: assessments(rows, name) for name in properties},
        "offset": offset,
        "limit": limit,
        "has_more": len(selected) > offset + limit,
    }
