"""Explainable constraint evaluation over one deterministic resolution (CFG-002).

Every declared rule reports exactly one outcome: `valid`, `invalid`, `unknown` or
`not_evaluated`, each with rule-level and fact-level reasons. Unknown never collapses
to valid: a missing, unknown or conflicting fact, or an unresolved input choice, makes
the rule unknown. `not_evaluated` means the rule did not apply or could not be compared
(for example a declared value carries no facts, or the recorded fact is text). Labels,
names and part numbers prove nothing; only explicit rules and recorded facts are used.
"""

from __future__ import annotations

import json
from decimal import Decimal

from specmate.facts.models import FactSubject
from specmate.facts.queries import assessments, subject_with_assertions
from specmate.operations import NotFound, PermissionDenied

OUTCOMES = ("valid", "invalid", "unknown", "not_evaluated")
SCOPE = "declared_rules_and_recorded_facts_of_exact_revisions"
LIMITATIONS = [
    "Only rules declared by the pinned option-set revision are evaluated.",
    "Facts are read from the exact chosen revision's ledger; definition-level facts, "
    "feature facts and condition-scoped facts are not applied to an unconditioned rule.",
    "A valid outcome is a declaration check, not physical qualification.",
]


def reason(level, code, message, **extra):
    return {"level": level, "code": code, "message": message, **extra}


def _decision_fact(decision):
    """A configuration fact: what one option resolved to and why."""
    choice = decision["choice"]
    return reason(
        "fact",
        f"decision_{decision['status']}",
        f"Option {decision['option_key']} is {decision['status']}"
        + (f" to choice {choice['key']}" if choice else "")
        + f" ({decision['source'].replace('_', ' ')}).",
        option_key=decision["option_key"],
        choice_key=choice["key"] if choice else None,
    )


def _applies(rule, decisions):
    """(applies, outcome-if-not, reasons) for a rule's `when` applicability."""
    when = rule.when
    if when is None:
        return True, None, []
    decision = decisions[when.option_key]
    facts = [_decision_fact(decision)]
    if decision["status"] in {"unresolved", "invalid"}:
        return (
            False,
            "unknown",
            [
                reason(
                    "rule",
                    "applicability_unknown",
                    f"Applies when {when.option_key} is {when.choice_key}; that option is "
                    f"{decision['status']}, so applicability is unknown.",
                ),
                *facts,
            ],
        )
    chosen = decision["choice"]["key"] if decision["choice"] else None
    if chosen != when.choice_key:
        return (
            False,
            "not_evaluated",
            [
                reason(
                    "rule",
                    "not_applicable",
                    f"Applies only when {when.option_key} is {when.choice_key}.",
                ),
                *facts,
            ],
        )
    return (
        True,
        None,
        [
            reason(
                "rule",
                "applicable",
                f"Applies because {when.option_key} is {when.choice_key}.",
            ),
            *facts,
        ],
    )


def _choice_rule(rule, decisions):
    applies, outcome, reasons = _applies(rule, decisions)
    if not applies:
        return outcome, reasons, []
    decision = decisions[rule.option_key]
    named = ", ".join(rule.choice_keys)
    verb = "requires" if rule.kind == "requires" else "excludes"
    reasons.append(
        reason("rule", f"choice_{rule.kind}", f"Rule {verb} {rule.option_key} in [{named}].")
    )
    reasons.append(_decision_fact(decision))
    if decision["status"] in {"unresolved", "invalid"}:
        reasons.append(
            reason(
                "rule",
                "input_unknown",
                f"{rule.option_key} is {decision['status']}; the rule cannot be decided.",
            )
        )
        return "unknown", reasons, []
    chosen = decision["choice"]["key"] if decision["choice"] else None
    member = chosen in rule.choice_keys
    holds = member if rule.kind == "requires" else not member
    return ("valid" if holds else "invalid"), reasons, []


def _bound(value, comparison):
    """Conservative (pass_at, fail_at) magnitudes of a recorded quantity or range."""
    if value["kind"] == "quantity":
        magnitude = Decimal(value["magnitude"])
        return magnitude, magnitude
    lower, upper = Decimal(value["lower"]), Decimal(value["upper"])
    # at_least passes only when the lowest candidate passes and fails when even the
    # highest fails; at_most mirrors that. Values between bounds stay unknown.
    return (lower, upper) if comparison == "at_least" else (upper, lower)


def _ledger(reader, revision_id):
    subject = FactSubject.objects.filter(
        kind="revision", revision_id=revision_id, feature_id__isnull=True
    ).first()
    if subject is None:
        return None, []
    _, rows = subject_with_assertions(reader.user, subject.id)
    return subject, rows


def _fact_rule(rule, decisions, reader):
    applies, outcome, reasons = _applies(rule, decisions)
    if not applies:
        return outcome, reasons, []
    limit = rule.limit.canonical()
    relation = "at least" if rule.comparison == "at_least" else "at most"
    reasons.append(
        reason(
            "rule",
            "fact_limit",
            f"Requires {rule.property} ({rule.purpose}, {rule.role}) {relation} "
            f"{rule.limit.magnitude} {rule.limit.unit} on the revision chosen for "
            f"{rule.option_key}.",
            limit=limit,
        )
    )
    decision = decisions[rule.option_key]
    reasons.append(_decision_fact(decision))
    if decision["status"] in {"unresolved", "invalid"}:
        reasons.append(
            reason("rule", "input_unknown", f"{rule.option_key} has no resolved choice yet.")
        )
        return "unknown", reasons, []
    if decision["status"] == "none":
        reasons.append(
            reason(
                "rule", "no_subject", f"{rule.option_key} is deliberately left without a choice."
            )
        )
        return "not_evaluated", reasons, []
    revision = decision["choice"]["revision"]
    if revision is None:
        reasons.append(
            reason(
                "rule",
                "declared_value",
                "The chosen declared value is not an exact revision and records no facts.",
            )
        )
        return "not_evaluated", reasons, []
    try:
        subject, rows = _ledger(reader, revision["revision_id"])
    except (NotFound, PermissionDenied):
        reasons.append(
            reason(
                "fact",
                "evidence_unavailable",
                "Fact evidence for the chosen revision is not readable under current authority.",
            )
        )
        return "unknown", reasons, []
    groups = [
        group
        for group in (assessments(rows, rule.property) if rows else [])
        if group.get("purpose") == rule.purpose and group.get("role") == rule.role
    ]
    unconditioned = [group for group in groups if not group["conditions"]]
    evidence = [
        {
            "subject_id": str(subject.id) if subject else None,
            "subject_state": subject.state_token if subject else None,
            "revision_id": revision["revision_id"],
            "property": rule.property,
            "purpose": rule.purpose,
            "role": rule.role,
            "conditions": group["conditions"],
            "status": group["status"],
            "value": group["value"],
            "assertion_ids": group["assertion_ids"],
        }
        for group in groups
    ]
    name = f"{revision['name']} rev {revision['number']}"
    if not groups:
        reasons.append(
            reason(
                "fact",
                "fact_missing",
                f"{name} records no {rule.property} ({rule.purpose}, {rule.role}); "
                "compatibility is not assumed.",
            )
        )
        return "unknown", reasons, evidence
    if not unconditioned:
        reasons.append(
            reason(
                "fact",
                "conditions_only",
                f"{name} records {rule.property} only under stated conditions; the rule "
                "declares none, so the recorded values are not applied.",
            )
        )
        return "unknown", reasons, evidence
    group = unconditioned[0]
    ids = group["assertion_ids"]
    status = group["status"]
    if status in {"unknown", "conflicting", "not_evaluated"}:
        reasons.append(
            reason(
                "fact",
                f"fact_{status}",
                f"{name} records {rule.property} as {status.replace('_', ' ')}.",
                assertion_ids=ids,
            )
        )
        return "unknown", reasons, evidence
    if status == "not_applicable":
        reasons.append(
            reason(
                "fact",
                "fact_not_applicable",
                f"{name} declares {rule.property} not applicable; the rule is not evaluated.",
                assertion_ids=ids,
            )
        )
        return "not_evaluated", reasons, evidence
    value = group["value"]
    if value.get("kind") not in {"quantity", "range"} or value.get("dimension") != (
        rule.limit.dimension
    ):
        reasons.append(
            reason(
                "fact",
                "incomparable",
                f"{name} records {rule.property} in a form that cannot be compared with a "
                f"{rule.limit.dimension} limit.",
                assertion_ids=ids,
            )
        )
        return "not_evaluated", reasons, evidence
    required = Decimal(limit["magnitude"])
    passing, failing = _bound(value, rule.comparison)
    if rule.comparison == "at_least":
        holds, fails = passing >= required, failing < required
    else:
        holds, fails = passing <= required, failing > required
    shown = json.dumps(value, sort_keys=True)
    if holds:
        outcome, code = "valid", "fact_satisfies"
    elif fails:
        outcome, code = "invalid", "fact_violates"
    else:
        outcome, code = "unknown", "fact_range_straddles"
    reasons.append(
        reason(
            "fact",
            code,
            f"{name} records {rule.property} {shown}; required {relation} "
            f"{limit['magnitude']} {limit['unit']}.",
            assertion_ids=ids,
        )
    )
    return outcome, reasons, evidence


def evaluate(reader, option_set, decisions):
    """Evaluate every declared rule against resolved decisions (keyed by option)."""
    by_key = {decision["option_key"]: decision for decision in decisions}
    results = []
    for rule in option_set.constraints:
        if rule.kind == "fact_limit":
            outcome, reasons, facts = _fact_rule(rule, by_key, reader)
        else:
            outcome, reasons, facts = _choice_rule(rule, by_key)
        results.append(
            {
                "key": rule.key,
                "label": rule.label,
                "kind": rule.kind,
                "basis": rule.basis,
                "rule": rule.model_dump(mode="json"),
                "outcome": outcome,
                "reasons": reasons,
                "facts": facts,
            }
        )
    counts = {outcome: sum(1 for r in results if r["outcome"] == outcome) for outcome in OUTCOMES}
    if counts["invalid"]:
        overall = "invalid"
    elif counts["unknown"]:
        overall = "unknown"
    elif counts["valid"]:
        overall = "valid"
    else:
        overall = "not_evaluated"
    return {
        "outcome": overall,
        "counts": counts,
        "results": results,
        "scope": SCOPE,
        "limitations": LIMITATIONS,
    }
