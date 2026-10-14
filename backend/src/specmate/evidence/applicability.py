"""EVD-003: link changed design state to stale or inapplicable evidence.

Reading applicability is derived on read from the exact revision numbers of the definition
and never stores, rewrites or reattaches an observation. Evidence about an earlier revision
stays attached to it and is reported as stale for the selected revision; evidence about a
later revision, or about a unit built to another revision, is reported as inapplicable.
Nothing here qualifies the selected revision: ``qualifies_selected_revision`` is always false.
"""

import json
from itertools import islice

from django.db.models import Q

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Revision
from specmate.evidence.contracts import ApplicabilityList, ReadApplicability
from specmate.evidence.models import RecordedPin, RecordedResult
from specmate.evidence.queries import CHUNK, SCAN_LIMIT, fact_item, recorded_item
from specmate.evidence.recorded import newer_assertions, pin_states
from specmate.facts.models import FactAssertion
from specmate.facts.queries import authorize_assertions, resolve_target, subject_target
from specmate.operations import NotFound, OperationError
from specmate.queries import get_revision

SECTION_LIMIT = 20
NOTES = {
    "stale_earlier_revision": (
        "Recorded against revision {then}. Revision {now} is selected; the old result is kept "
        "unchanged and its applicability to the changed design is limited until re-established."
    ),
    "inapplicable_later_revision": (
        "Recorded against later revision {then}; it says nothing about selected revision {now}."
    ),
    "exact_revision": "Recorded against this exact revision.",
    "exact_unit_only": (
        "Observed on one physical unit built to this exact revision; it does not qualify any "
        "other unit of the same revision."
    ),
    "definition_scope_unverified": (
        "Attached to the definition as a whole, not to a revision; whether it holds for the "
        "selected revision is not established."
    ),
    "unit_earlier_revision": (
        "Observed on a unit built to revision {then}. The observation stays true of that unit "
        "but is stale for selected revision {now}."
    ),
    "unit_later_revision": (
        "Observed on a unit built to later revision {then}; inapplicable to selected "
        "revision {now}."
    ),
}


def content_of(revision):
    return json.loads(bytes(revision.snapshot.canonical)).get("content", {})


def changed_sections(old, new):
    """Dotted names of top-level (and one nested level of) content that differ."""
    names = []
    for key in sorted(old.keys() | new.keys()):
        before, after = old.get(key), new.get(key)
        if before == after:
            continue
        if isinstance(before, dict) and isinstance(after, dict):
            names.extend(
                f"{key}.{sub}"
                for sub in sorted(before.keys() | after.keys())
                if before.get(sub) != after.get(sub)
            )
        else:
            names.append(key)
    return names


def change_between(then, now):
    old, new = content_of(then), content_of(now)
    if then.snapshot.sha256 == now.snapshot.sha256:
        names = []
    else:
        names = changed_sections(old, new)
    return {
        "from_number": then.number,
        "to_number": now.number,
        "content_changed": bool(names) or then.snapshot.sha256 != now.snapshot.sha256,
        "changed_sections": names[:SECTION_LIMIT],
        "sections_truncated": len(names) > SECTION_LIMIT,
    }


def classify(selected, evidence_revision, *, unit=False):
    """Applicability of evidence attached to ``evidence_revision`` for ``selected``."""
    if evidence_revision.id == selected.id:
        status = "exact_unit_only" if unit else "exact_revision"
        return {
            "status": status,
            "reason": NOTES[status],
            "evidence_revision_id": evidence_revision.id,
            "evidence_revision_number": evidence_revision.number,
        }
    earlier = evidence_revision.number < selected.number
    status = "stale_earlier_revision" if earlier else "inapplicable_later_revision"
    note = NOTES[("unit_" + ("earlier" if earlier else "later") + "_revision") if unit else status]
    then, now = evidence_revision, selected
    return {
        "status": status,
        "reason": note.format(then=then.number, now=now.number),
        "evidence_revision_id": then.id,
        "evidence_revision_number": then.number,
        "change": change_between(then, now) if earlier else None,
    }


def applicability_items(user, p, selected, scan):
    siblings = {
        r.id: r
        for r in Revision.objects.select_related("snapshot").filter(
            definition_id=selected.definition_id
        )
    }
    ids = list(siblings)
    scope = (
        Q(subject__kind="revision", subject__revision_id__in=ids)
        | Q(subject__kind="definition", subject__definition_id=selected.definition_id)
        | Q(subject__kind="occurrence", subject__snapshot__revision__in=ids)
        | Q(subject__kind="physical_unit", subject__physical_unit__revision_id__in=ids)
    )
    rows = (
        FactAssertion.objects.filter(subject__workspace_id=p.workspace_id)
        .filter(scope)
        .select_related("subject__physical_unit", "subject__snapshot__revision")
        .prefetch_related("source_links__source_file")
        .order_by("-recorded_at", "-id")
    )
    out, readable = [], {}
    for index in range(0, SCAN_LIMIT, CHUNK):
        chunk = list(rows[index : index + CHUNK])
        for assertion in chunk:
            subject = assertion.subject
            if subject.id not in readable:
                try:
                    resolve_target(user, subject_target(subject))
                    readable[subject.id] = True
                except OperationError:
                    readable[subject.id] = False
            if not readable[subject.id]:
                continue
            try:
                authorize_assertions(user, [assertion])
            except OperationError:
                continue
            if subject.kind == "definition":
                applicability = {
                    "status": "definition_scope_unverified",
                    "reason": NOTES["definition_scope_unverified"],
                }
            elif subject.kind == "revision":
                applicability = classify(selected, siblings[subject.revision_id])
            elif subject.kind == "occurrence":
                applicability = classify(selected, siblings[subject.snapshot.revision.id])
            else:
                applicability = classify(
                    selected, siblings[subject.physical_unit.revision_id], unit=True
                )
            out.append(
                ((assertion.recorded_at, str(assertion.id)), fact_item(assertion), applicability)
            )
        if len(chunk) < CHUNK:
            break
    else:
        scan.limit_reached = True
    record_ids = list(
        RecordedPin.objects.filter(revision_id__in=ids)
        .values_list("record_id", flat=True)
        .distinct()[:SCAN_LIMIT]
    )
    records = list(
        RecordedResult.objects.filter(id__in=record_ids, workspace_id=p.workspace_id).order_by(
            "-recorded_at", "-id"
        )
    )
    states = pin_states(records)
    for record in records:
        pins = states.get(record.id, [])
        item = recorded_item(record, pins, newer_assertions(record))
        # The most recent pinned revision of this definition decides how the record reads.
        pinned = sorted(
            (siblings[pin["revision_id"]] for pin in pins if pin["revision_id"] in siblings),
            key=lambda r: r.number,
        )
        exact = next((r for r in pinned if r.id == selected.id), None)
        basis = exact or pinned[-1]
        out.append(((record.recorded_at, str(record.id)), item, classify(selected, basis)))
    out.sort(key=lambda row: row[0], reverse=True)
    return out


def read_applicability(user, p: ReadApplicability):
    authorize(user, p.workspace_id, Perm.WORKSPACE_READ)
    selected = get_revision(user, p.revision_id)
    if selected.definition.workspace_id != p.workspace_id:
        raise NotFound("Revision not found.")

    class Scan:
        limit_reached = False

    scan = Scan()
    rows = applicability_items(user, p, selected, scan)
    window = list(islice(rows, p.offset, p.offset + p.limit + 1))
    latest = max(
        Revision.objects.filter(definition_id=selected.definition_id).values_list(
            "number", flat=True
        )
    )
    return ApplicabilityList.model_validate(
        {
            "workspace_id": p.workspace_id,
            "revision": {
                "revision_id": selected.id,
                "definition_id": selected.definition_id,
                "number": selected.number,
                "latest_number": latest,
                "is_latest": selected.number == latest,
            },
            "items": [
                {"item": item, "applicability": applicability}
                for _, item, applicability in window[: p.limit]
            ],
            "offset": p.offset,
            "limit": p.limit,
            "has_more": len(window) > p.limit,
            "scan_limit_reached": scan.limit_reached,
        }
    ).model_dump(mode="json")
