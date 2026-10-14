"""Scoped evidence read model over source modules that remain authoritative.

Each source module maps its own records onto the shared taxonomy. Items are filtered
by current authority per record; unreadable records are omitted, never counted or named.
"""

from collections import Counter
from heapq import merge
from itertools import islice

from specmate.access.permissions import Perm, authorize
from specmate.builds.models import BuildAttempt
from specmate.design.models import Revision
from specmate.evidence.contracts import EvidenceItem, EvidenceList, ListEvidence
from specmate.evidence.models import RecordedResult
from specmate.evidence.recorded import authorize_record, pin_states
from specmate.evidence.taxonomy import FACT_METHOD_KIND, KIND_INFO, fact_kind
from specmate.facts.models import FactAssertion
from specmate.facts.queries import authorize_assertions, resolve_target, subject_target
from specmate.operations import NotFound, OperationError
from specmate.physical_units.models import PhysicalUnit
from specmate.physical_units.queries import get_unit

CHUNK = 100
# Records examined per source for one request, so a sparse authorized set cannot make
# a read unbounded.
SCAN_LIMIT = 2000
FACT_KINDS = {"source_claim", "review", "calculation", "physical_measurement", "preference"}
RATING_NOTE = "A declared rating is not a measured result or a verified imported fact."


class Scan:
    def __init__(self):
        self.limit_reached = False


def describe(kind, extra_does_not=()):
    info = KIND_INFO[kind]
    return {
        "kind": kind,
        "kind_label": info["label"],
        "establishes": list(info["establishes"]),
        "does_not_establish": [*info["does_not_establish"], *extra_does_not],
    }


def value_text(value):
    if not value:
        return "no value"
    if value["kind"] == "text":
        return value["text"]
    if value["kind"] == "boolean":
        return "true" if value["value"] else "false"
    if value["kind"] == "range":
        return f"{value['lower']} to {value['upper']} {value['unit']}"
    if value["kind"] == "tolerance":
        return f"-{value['minus']} / +{value['plus']} {value['unit']}"
    return f"{value['magnitude']} {value['unit']}"


def subject_ref(subject):
    if subject.kind == "physical_unit":
        return {
            "scope": "actual",
            "kind": "physical_unit",
            "id": subject.physical_unit_id,
            "label": f"Physical unit {subject.physical_unit.serial}",
        }
    identity = {
        "project": subject.project_id,
        "definition": subject.definition_id,
        "revision": subject.revision_id,
        "occurrence": subject.snapshot_id,
    }[subject.kind]
    label = subject.kind.capitalize() + (f" {'/'.join(subject.path)}" if subject.path else "")
    if subject.feature_id:
        label += f" / {subject.feature_id}"
    return {
        "scope": "project" if subject.kind == "project" else "design",
        "kind": subject.kind,
        "id": identity,
        "label": label,
    }


def fact_origin(method, has_source_files):
    return {
        "source_observation": "registered_source" if has_source_files else "manual_entry",
        "reviewed_association": "human_review",
        "calculation": "assertion_inputs",
        "measurement": "instrument_record",
        "preference": "declared_preference",
    }[method]


def fact_item(assertion):
    subject = assertion.subject
    content = assertion.content
    provenance = content["provenance"]
    kind, warnings = fact_kind(assertion.method, subject.kind)
    sources = [
        f"source:{link.source_file.revision_id}/{link.source_file.path}"
        for link in assertion.source_links.all()
    ]
    references = [
        *sources,
        *(f"citation:{e['citation']}" for e in provenance["evidence"] if e["kind"] == "citation"),
        *(
            f"assertion:{e['assertion_id']}"
            for e in provenance["evidence"]
            if e["kind"] == "assertion"
        ),
    ]
    rating = kind == "source_claim" and content["purpose"] == "rating"
    statement = (
        f"{content['property']} = {value_text(content['value'])}"
        f" ({content['role']}, {content['purpose']})"
        if content["status"] == "known"
        else f"{content['property']}: {content['status'].replace('_', ' ')}"
    )
    if rating:
        statement = f"Declared rating: {statement}"
    return {
        **describe(kind, [RATING_NOTE] if rating else []),
        "evidence_id": f"fact:{assertion.id}",
        "source": "facts",
        "workspace_id": subject.workspace_id,
        "subject": subject_ref(subject),
        "statement": statement,
        "status": content["status"],
        "conditions": assertion.canonical_conditions,
        "method": {
            "name": provenance["method"],
            "procedure": provenance.get("procedure"),
            "instrument": provenance.get("instrument"),
            "formula": provenance.get("formula"),
            "algorithm_version": provenance.get("algorithm_version"),
        },
        "basis": {
            "origin": fact_origin(assertion.method, bool(sources)),
            "references": references,
            "independently_verified": False,
        },
        "recorded_at": assertion.recorded_at.isoformat(),
        "observed_at": provenance.get("observed_at"),
        "actor_id": assertion.actor_id,
        "warnings": warnings,
    }


def fact_items(user, p, kinds, scan):
    methods = [
        method
        for method, kind in FACT_METHOD_KIND.items()
        if kinds is None
        or kind in kinds
        # Legacy non-physical measurements read as declared claims.
        or (method == "measurement" and "source_claim" in kinds)
    ]
    rows = FactAssertion.objects.filter(subject__workspace_id=p.workspace_id, method__in=methods)
    if p.subject_id:
        rows = rows.filter(subject_id=p.subject_id)
    rows = rows.select_related("subject__physical_unit").prefetch_related(
        "source_links__source_file"
    )
    rows = rows.order_by("-recorded_at", "-id")
    readable = {}
    for index in range(0, SCAN_LIMIT, CHUNK):
        chunk = list(rows[index : index + CHUNK])
        for assertion in chunk:
            if assertion.subject_id not in readable:
                try:
                    resolve_target(user, subject_target(assertion.subject))
                    readable[assertion.subject_id] = True
                except OperationError:
                    readable[assertion.subject_id] = False
            if not readable[assertion.subject_id]:
                continue
            try:
                authorize_assertions(user, [assertion])
            except OperationError:
                continue
            item = fact_item(assertion)
            if kinds is None or item["kind"] in kinds:
                yield (assertion.recorded_at, str(assertion.id)), item
        if len(chunk) < CHUNK:
            return
    scan.limit_reached = True


def build_item(build):
    stage = build.stage
    receipt = stage.receipt or {}
    outcome = receipt.get("outcome") or stage.state
    return {
        **describe("generated_check"),
        "evidence_id": f"build:{build.id}",
        "source": "builds",
        "workspace_id": build.workspace_id,
        "subject": {
            "scope": "design",
            "kind": "source_bundle_revision",
            "id": build.source_revision_id,
            "label": f"Source bundle revision {build.source_revision_id}",
        },
        "statement": f"Recipe {build.recipe_id}: {outcome}",
        "status": outcome,
        "conditions": [],
        "method": {"name": "recipe", "tool": build.recipe_id},
        "basis": {
            "origin": "tool_receipt",
            "references": [f"build:{build.id}"],
            "independently_verified": False,
        },
        "recorded_at": build.created_at.isoformat(),
        "actor_id": build.requested_by_id,
        "warnings": [] if stage.receipt else ["No terminal receipt is recorded yet."],
    }


def build_items(user, p, scan):
    from specmate.queries import get_bundle_revision

    rows = (
        BuildAttempt.objects.filter(workspace_id=p.workspace_id)
        .select_related("stage")
        .order_by("-created_at", "-id")
    )
    for index in range(0, SCAN_LIMIT, CHUNK):
        chunk = list(rows[index : index + CHUNK])
        for build in chunk:
            try:
                get_bundle_revision(user, build.source_revision_id)
            except OperationError:
                continue
            yield (build.created_at, str(build.id)), build_item(build)
        if len(chunk) < CHUNK:
            return
    scan.limit_reached = True


def plan_items(user, p, scan):
    from specmate.cable_test_intent.queries import result

    rows = (
        Revision.objects.filter(
            definition__workspace_id=p.workspace_id, definition__kind="cable_test_plan"
        )
        .select_related("definition")
        .order_by("-frozen_at", "-id")
    )
    for index in range(0, SCAN_LIMIT, CHUNK):
        chunk = list(rows[index : index + CHUNK])
        for revision in chunk:
            try:
                plan = result(user, revision.id)
            except OperationError:
                continue
            intents = [pair["intent"] for pair in plan["test_plan"]["pairs"]]
            yield (
                (revision.frozen_at, str(revision.id)),
                {
                    **describe("requirement"),
                    "evidence_id": f"requirement:{revision.id}",
                    "source": "cable_test_plan",
                    "workspace_id": p.workspace_id,
                    "subject": {
                        "scope": "design",
                        "kind": "revision",
                        "id": plan["test_plan"]["cable_revision_id"],
                        "label": f"Cable revision {plan['test_plan']['cable_revision_id']}",
                    },
                    "statement": (
                        f"Test intent: {intents.count('continuity')} continuity, "
                        f"{intents.count('isolation')} isolation, "
                        f"{intents.count('unknown')} unknown-intent pair expectations"
                    ),
                    "status": "declared",
                    "conditions": [],
                    "method": {"name": "test_intent"},
                    "basis": {
                        "origin": "plan_declaration",
                        "references": [f"revision:{revision.id}"],
                        "independently_verified": False,
                    },
                    "recorded_at": revision.frozen_at.isoformat(),
                    "actor_id": revision.frozen_by_id,
                    "warnings": [f"Physical test: {plan['physical_test'].replace('_', ' ')}."],
                },
            )
        if len(chunk) < CHUNK:
            return
    scan.limit_reached = True


def unit_items(user, p, kinds, scan):
    rows = PhysicalUnit.objects.filter(workspace_id=p.workspace_id).order_by("-created_at", "-id")
    for index in range(0, SCAN_LIMIT, CHUNK):
        chunk = list(rows[index : index + CHUNK])
        for unit in chunk:
            try:
                get_unit(user, unit.id)
            except OperationError:
                continue
            declared = unit.assertion_status == "declared"
            kind = "source_claim" if declared else "physical_observation"
            if kinds is not None and kind not in kinds:
                continue
            warnings = []
            if unit.assertion_status == "measured":
                warnings.append(
                    "Status 'measured' is a declaration; no instrument or procedure is "
                    "recorded here, so it is not a physical measurement."
                )
            yield (
                (unit.created_at, str(unit.id)),
                {
                    **describe(kind),
                    "evidence_id": f"unit:{unit.id}",
                    "source": "physical_units",
                    "workspace_id": unit.workspace_id,
                    "subject": {
                        "scope": "actual",
                        "kind": "physical_unit",
                        "id": unit.id,
                        "label": f"Physical unit {unit.serial}",
                    },
                    "statement": f"Unit {unit.serial} registered as {unit.origin}",
                    "status": unit.assertion_status,
                    "conditions": [],
                    "method": {"name": f"unit_{unit.assertion_status}"},
                    "basis": {
                        "origin": "unit_declaration",
                        "references": [f"declared source:{unit.assertion_source}"],
                        "independently_verified": False,
                    },
                    "recorded_at": unit.created_at.isoformat(),
                    "actor_id": unit.registered_by_id,
                    "warnings": warnings,
                },
            )
        if len(chunk) < CHUNK:
            return
    scan.limit_reached = True


RECORDED_NOTE = "That the recorded result still holds for newer revisions of its inputs."


def recorded_item(record, pins):
    result = record.result
    by_role = {pin["role"]: pin for pin in pins}
    if record.source == RecordedResult.Source.INTERFACE_ASSESSMENT:
        counts = Counter(f["status"] for f in result["assessment"]["findings"])
        statement = (
            f"Interface assessment: {counts['satisfied']} satisfied by declarations, "
            f"{counts['invalid']} invalid, {counts['flagged']} flagged, "
            f"{counts['unknown']} unknown findings; no overall compatibility result"
        )
        pin = by_role["assessment"]
        subject = {
            "scope": "design",
            "kind": "revision",
            "id": pin["revision_id"],
            "label": f"Interface assessment revision {pin['number']}",
        }
        status, method, warnings = "recorded", "interface_assessment", []
    else:
        counts = Counter(f["status"] for f in result["findings"])
        statement = (
            f"Firmware impact review: {counts['changed']} changed, {counts['unknown']} unknown, "
            f"{counts['unchanged']} unchanged recorded assumptions; "
            f"{result['observations_total']} historical observations in scope"
        )
        candidate, baseline = by_role["candidate_firmware"], by_role["baseline_firmware"]
        subject = {
            "scope": "design",
            "kind": "revision",
            "id": candidate["revision_id"],
            "label": (
                f"Firmware revision {candidate['number']} (candidate; baseline "
                f"revision {baseline['number']})"
            ),
        }
        status = "review_required" if result["review_required"] else "recorded"
        method = "firmware_impact_comparison"
        warnings = ["Hardware compatibility, flashing and device operation are not evaluated."]
        if result["observations_truncated"]:
            warnings.append(
                f"Recorded one page of {result['observations_total']} historical observations "
                f"from position {result['observation_offset'] + 1}."
            )
    stale = [pin for pin in pins if pin["newer_revision_exists"]]
    warnings = [
        f"Stale: pinned {pin['role'].replace('_', ' ')} revision {pin['number']} has newer "
        f"revision {pin['latest_number']}. The recorded result is kept unchanged."
        for pin in stale
    ] + warnings
    return {
        **describe("generated_check", [RECORDED_NOTE]),
        "evidence_id": f"recorded:{record.id}",
        "source": record.source,
        "workspace_id": record.workspace_id,
        "subject": subject,
        "statement": statement,
        "status": status,
        "conditions": [],
        "method": {"name": method, "algorithm_version": record.algorithm_version},
        "basis": {
            "origin": "recorded_result",
            "references": [
                f"recorded:{record.id}",
                f"sha256:{record.result_sha256}",
                *(f"revision:{pin['revision_id']} ({pin['role']})" for pin in pins),
            ],
            "independently_verified": False,
        },
        "recorded_at": record.recorded_at.isoformat(),
        "actor_id": record.recorded_by_id,
        "warnings": warnings,
        "stale": bool(stale),
    }


def recorded_items(user, p, scan):
    rows = RecordedResult.objects.filter(workspace_id=p.workspace_id).order_by(
        "-recorded_at", "-id"
    )
    for index in range(0, SCAN_LIMIT, CHUNK):
        chunk = list(rows[index : index + CHUNK])
        states = pin_states(chunk)
        for record in chunk:
            try:
                authorize_record(user, record)
            except OperationError:
                continue
            yield (
                (record.recorded_at, str(record.id)),
                recorded_item(record, states.get(record.id, [])),
            )
        if len(chunk) < CHUNK:
            return
    scan.limit_reached = True


def list_evidence(user, p: ListEvidence):
    authorize(user, p.workspace_id, Perm.WORKSPACE_READ)
    kinds = set(p.kinds) if p.kinds else None
    scan = Scan()
    sources = []
    if kinds is None or kinds & FACT_KINDS:
        sources.append(fact_items(user, p, kinds, scan))
    if p.subject_id is None:
        if kinds is None or "generated_check" in kinds:
            sources.append(build_items(user, p, scan))
            sources.append(recorded_items(user, p, scan))
        if kinds is None or "requirement" in kinds:
            sources.append(plan_items(user, p, scan))
        if kinds is None or kinds & {"source_claim", "physical_observation"}:
            sources.append(unit_items(user, p, kinds, scan))
    elif not sources:
        raise NotFound("Evidence subject unavailable.")
    window = list(
        islice(
            merge(*sources, key=lambda pair: pair[0], reverse=True),
            p.offset + p.limit + 1,
        )
    )
    items = [item for _, item in window[p.offset : p.offset + p.limit]]
    return EvidenceList(
        workspace_id=p.workspace_id,
        items=[EvidenceItem.model_validate(item) for item in items],
        offset=p.offset,
        limit=p.limit,
        has_more=len(window) > p.offset + p.limit,
        scan_limit_reached=scan.limit_reached,
    ).model_dump(mode="json")
