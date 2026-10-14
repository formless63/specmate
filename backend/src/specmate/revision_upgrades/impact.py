"""CFG-004: computed impact of a proposal, derived on read and never adopted.

Every discipline reports ``changed``, ``unknown``, ``no_difference_found``, ``none_found``
(evidence only) or ``not_evaluated`` with a reason. ``no_difference_found`` only means no
compared section mapped to that discipline changed; anything a comparison cannot see stays
``unknown`` or ``not_evaluated`` and is never read as "no impact".
"""

from types import SimpleNamespace

from specmate.evidence.applicability import applicability_items, change_between, changed_sections
from specmate.evidence.applicability import content_of as revision_content
from specmate.evidence.contracts import ApplicabilityItem
from specmate.operations import OperationError

DISCIPLINES = ("electrical", "mechanical", "firmware", "manufacturing", "evidence")
EVIDENCE_LIMIT = 50

# Cable revision sections (cables.queries.length_impact) and the disciplines they touch.
CABLE_SECTIONS = {
    "stock": {"electrical", "mechanical", "manufacturing"},
    "connectors": {"electrical", "mechanical", "manufacturing"},
    "terminations": {"electrical", "manufacturing"},
    "lengths": {"mechanical", "manufacturing"},
    "labels": {"manufacturing"},
    "review": {"manufacturing"},
}
CABLE_DISCIPLINES = ("electrical", "mechanical", "manufacturing")


def not_evaluated(reason):
    return {"status": "not_evaluated", "reason": reason, "sections": []}


def content_comparison(old, candidate, relation):
    """Generic frozen-content comparison: what changed, never what that change means."""
    if relation == "later_revision":
        change = change_between(old, candidate)
        return {"comparable": True, **change}
    names = changed_sections(revision_content(old), revision_content(candidate))
    return {
        "comparable": True,
        "from_number": old.number,
        "to_number": candidate.number,
        "content_changed": bool(names) or old.snapshot.sha256 != candidate.snapshot.sha256,
        "changed_sections": names[:20],
        "sections_truncated": len(names) > 20,
    }


def cable_sections(user, old, candidate):
    from specmate.cables.queries import length_impact

    try:
        report = length_impact(user, old.id, candidate.id)
    except OperationError as exc:
        return None, str(exc)
    return report["sections"], None


def cable_disciplines(sections, identical):
    out = {}
    for discipline in CABLE_DISCIPLINES:
        touched = [
            s["section"]
            for s in sections
            if s["status"] == "uncomparable" or discipline in CABLE_SECTIONS.get(s["section"], ())
        ]
        unknown = [
            s["section"]
            for s in sections
            if s["status"] == "uncomparable" or s["section"] not in CABLE_SECTIONS
        ]
        if unknown:
            out[discipline] = {
                "status": "unknown",
                "reason": "Cable content changed in sections without a known discipline "
                f"mapping ({', '.join(sorted(set(unknown)))}); review is required.",
                "sections": sorted(set(touched)),
            }
        elif touched:
            out[discipline] = {
                "status": "changed",
                "reason": f"Changed cable sections: {', '.join(sorted(set(touched)))}.",
                "sections": sorted(set(touched)),
            }
        elif identical:
            out[discipline] = {
                "status": "no_difference_found",
                "reason": "Old and candidate frozen cable content is identical.",
                "sections": [],
            }
        else:
            out[discipline] = {
                "status": "no_difference_found",
                "reason": "No compared cable section that maps to this discipline changed. "
                "Behaviour outside the compared sections is not evaluated.",
                "sections": [],
            }
    out["firmware"] = not_evaluated(
        "Cable revisions declare no firmware; firmware assignments on the selected uses are "
        "listed per occurrence and are not compared here."
    )
    return out


def compact(row):
    data = ApplicabilityItem.model_validate(row).model_dump(mode="json")
    item, applicability = data["item"], data["applicability"]
    return {
        "evidence_id": item["evidence_id"],
        "kind_label": item["kind_label"],
        "statement": item["statement"],
        "subject": item["subject"]["label"],
        "recorded_at": item["recorded_at"],
        "applicability": applicability["status"],
        "reason": applicability["reason"],
        "evidence_revision_number": applicability.get("evidence_revision_number"),
        "changed_sections": (applicability.get("change") or {}).get("changed_sections", []),
    }


def evidence_for(user, selected, keep):
    params = SimpleNamespace(workspace_id=selected.definition.workspace_id)
    scan = SimpleNamespace(limit_reached=False)
    rows = [
        {"item": item, "applicability": applicability}
        for _, item, applicability in applicability_items(user, params, selected, scan)
        if keep(applicability)
    ]
    return {
        "items": [compact(row) for row in rows[:EVIDENCE_LIMIT]],
        "total": len(rows),
        "truncated": len(rows) > EVIDENCE_LIMIT,
        "scan_limit_reached": scan.limit_reached,
    }


def evidence_impact(user, old, candidate, consumer_revision, relation):
    if relation == "later_revision":
        # Read against the candidate: evidence attached to the exact old revision becomes
        # stale for the adopted use (kept unchanged, never moved to the candidate).
        becomes_stale = evidence_for(
            user,
            candidate,
            lambda a: a.get("evidence_revision_id") == old.id,
        )
        stale_reason = (
            "Recorded against the old revision; after adoption it reads as stale for the "
            "candidate revision and does not qualify it."
        )
    else:
        exact = {"exact_revision", "exact_unit_only", "exact_batch_only"}
        becomes_stale = evidence_for(user, old, lambda a: a["status"] in exact)
        stale_reason = (
            "Recorded against the old definition; a declared replacement is a different "
            "definition, so this evidence does not apply to the candidate."
        )
    unverified = evidence_for(
        user,
        candidate if relation == "later_revision" else old,
        lambda a: a["status"] == "definition_scope_unverified",
    )
    consumer = None
    if consumer_revision is not None:
        consumer = evidence_for(
            user,
            consumer_revision,
            lambda a: a.get("evidence_revision_id") == consumer_revision.id,
        )
        consumer["reason"] = (
            "Recorded against the consuming revision; a consuming revision frozen after "
            "adoption is not qualified by it."
        )
    candidate_exact = (
        evidence_for(
            user,
            candidate,
            lambda a: a.get("evidence_revision_id") == candidate.id,
        )
        if relation == "later_revision"
        else evidence_for(
            user,
            candidate,
            lambda a: a["status"] in {"exact_revision", "exact_unit_only", "exact_batch_only"},
        )
    )
    becomes_stale["reason"] = stale_reason
    unverified["reason"] = (
        "Attached to the definition as a whole; whether it holds for the candidate is not "
        "established."
    )
    candidate_exact["reason"] = (
        "Already recorded against the candidate revision; listed for review, not as "
        "qualification of this use."
    )
    affected = becomes_stale["total"] + (consumer["total"] if consumer else 0)
    limited = any(
        group and (group["scan_limit_reached"])
        for group in (becomes_stale, unverified, consumer, candidate_exact)
    )
    if affected:
        discipline = {
            "status": "changed",
            "reason": f"{affected} evidence record(s) become stale or inapplicable on adoption.",
            "sections": [],
        }
    elif limited:
        discipline = {
            "status": "unknown",
            "reason": "The evidence scan limit was reached; stale evidence may be incomplete.",
            "sections": [],
        }
    else:
        discipline = {
            "status": "none_found",
            "reason": "No readable evidence is recorded against the old or consuming "
            "revision. Evidence you cannot read is not counted.",
            "sections": [],
        }
    return discipline, {
        "becomes_stale": becomes_stale,
        "consumer_stale": consumer,
        "definition_scope_unverified": unverified,
        "candidate_recorded": candidate_exact,
    }


def computed_impact(user, old, candidate, consumer_revision, relation):
    kind = old.definition.kind
    content = content_comparison(old, candidate, relation)
    identical = old.snapshot.sha256 == candidate.snapshot.sha256
    sections = []
    if kind == "cable" and relation == "later_revision":
        found, failure = cable_sections(user, old, candidate)
        if found is None:
            disciplines = {
                d: {
                    "status": "unknown",
                    "reason": f"Cable section comparison failed: {failure}",
                    "sections": [],
                }
                for d in CABLE_DISCIPLINES
            }
            disciplines["firmware"] = not_evaluated("Cable revisions declare no firmware.")
            adapter = {"name": "cable_sections", "status": "failed", "reason": failure}
        else:
            sections = found
            disciplines = cable_disciplines(sections, identical)
            adapter = {"name": "cable_sections", "status": "computed", "reason": None}
    else:
        reason = (
            "A declared replacement is a different definition; only the generic content "
            "difference is shown and no discipline is compared."
            if relation == "declared_replacement"
            else f"No discipline impact adapter exists for {kind} revisions; only the generic "
            "content difference is shown."
        )
        disciplines = {d: not_evaluated(reason) for d in DISCIPLINES if d != "evidence"}
        adapter = {"name": None, "status": "not_available", "reason": reason}
    evidence_discipline, evidence = evidence_impact(
        user, old, candidate, consumer_revision, relation
    )
    disciplines["evidence"] = evidence_discipline
    return {
        "kind": kind,
        "adapter": adapter,
        "content": content,
        "sections": sections,
        "disciplines": {d: disciplines[d] for d in DISCIPLINES},
        "evidence": evidence,
        "derived_on_read": True,
        "adopted": False,
        "compatibility": "not_evaluated",
    }
