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
from specmate.facts.queries import assessments, canonical_conditions, subject_with_assertions
from specmate.operations import NotFound, PermissionDenied

OUTCOMES = ("valid", "invalid", "unknown", "not_evaluated")
SCOPE = "declared_rules_and_recorded_facts_of_exact_revisions"
LIMITATIONS = [
    "Only rules declared by the pinned option-set revision are evaluated.",
    "Facts are read from the exact chosen revision's ledger first, then from its "
    "definition's ledger; an exact-revision fact for the same purpose, role and conditions "
    "overrides the definition-level one. Feature facts apply only to a rule naming that "
    "feature; condition-scoped facts apply only to a rule stating the same conditions.",
    "The built-in firmware target check compares declarations only: the firmware's declared "
    "target population against the population chosen in the same configuration.",
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


LEVELS = {
    ("revision", False): "exact-revision",
    ("definition", False): "definition-level",
    ("revision", True): "exact-revision feature",
    ("definition", True): "definition-level feature",
}


def _ledger(reader, kind, owner_id, feature_id):
    """The fact subject and assertions of one level, or (None, []) when none is recorded."""
    key = {"revision_id": owner_id} if kind == "revision" else {"definition_id": owner_id}
    subject = FactSubject.objects.filter(
        kind=kind, feature_id=feature_id, feature_id__isnull=feature_id is None, **key
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
    feature = rule.feature_id
    wanted = canonical_conditions(rule)
    levels = []
    try:
        for kind, owner in (
            ("revision", revision["revision_id"]),
            ("definition", revision["definition_id"]),
        ):
            subject, rows = _ledger(reader, kind, owner, feature)
            label = LEVELS[(kind, feature is not None)]
            groups = [
                group
                for group in (assessments(rows, rule.property) if rows else [])
                if group.get("purpose") == rule.purpose and group.get("role") == rule.role
            ]
            levels.append((kind, label, subject, groups))
    except (NotFound, PermissionDenied):
        reasons.append(
            reason(
                "fact",
                "evidence_unavailable",
                "Fact evidence for the chosen revision or its definition is not readable "
                "under current authority.",
            )
        )
        return "unknown", reasons, []
    chosen = None
    for kind, label, _subject, groups in levels:
        match = [group for group in groups if group["conditions"] == wanted]
        if match and chosen is None:
            chosen = (kind, label, match[0])
    evidence = [
        {
            "subject_id": str(subject.id) if subject else None,
            "subject_state": subject.state_token if subject else None,
            "revision_id": revision["revision_id"],
            "fact_level": label,
            "applied": chosen is not None and chosen[2] is group,
            "property": rule.property,
            "purpose": rule.purpose,
            "role": rule.role,
            "conditions": group["conditions"],
            "status": group["status"],
            "value": group["value"],
            "assertion_ids": group["assertion_ids"],
        }
        for kind, label, subject, groups in levels
        for group in groups
    ]
    name = f"{revision['name']} rev {revision['number']}"
    where = " or ".join(label for _, label, _, _ in levels)
    if not any(groups for _, _, _, groups in levels):
        reasons.append(
            reason(
                "fact",
                "fact_missing",
                f"{name} records no {rule.property} ({rule.purpose}, {rule.role}) at the "
                f"{where} level; compatibility is not assumed.",
            )
        )
        return "unknown", reasons, evidence
    if chosen is None:
        stated = "the stated conditions" if wanted else "no conditions"
        reasons.append(
            reason(
                "fact",
                "conditions_unmatched" if wanted else "conditions_only",
                f"{name} records {rule.property} only under other conditions; the rule "
                f"states {stated}, so the recorded values are not applied.",
            )
        )
        return "unknown", reasons, evidence
    _, level, group = chosen
    name = f"{name} ({level} fact)"
    ids = group["assertion_ids"]
    status = group["status"]
    extra = {"assertion_ids": ids, "fact_level": level}
    if status in {"unknown", "conflicting", "not_evaluated"}:
        reasons.append(
            reason(
                "fact",
                f"fact_{status}",
                f"{name} records {rule.property} as {status.replace('_', ' ')}.",
                **extra,
            )
        )
        return "unknown", reasons, evidence
    if status == "not_applicable":
        reasons.append(
            reason(
                "fact",
                "fact_not_applicable",
                f"{name} declares {rule.property} not applicable; the rule is not evaluated.",
                **extra,
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
                **extra,
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
            **extra,
        )
    )
    return outcome, reasons, evidence


def _firmware_target_rule(option, by_key):
    """Built-in: the firmware's declared target population must match the chosen one."""
    reasons = [
        reason(
            "rule",
            "firmware_target",
            f"Firmware chosen for {option['option_key']} must declare the population "
            "chosen in this configuration as its target.",
        ),
        _decision_fact(option),
    ]
    if option["status"] in {"unresolved", "invalid"}:
        reasons.append(
            reason("rule", "input_unknown", f"{option['option_key']} has no resolved choice yet.")
        )
        return "unknown", reasons
    if option["status"] == "none":
        reasons.append(
            reason("rule", "no_subject", f"{option['option_key']} is left without a choice.")
        )
        return "not_evaluated", reasons
    declared = option["choice"]["declared_target"]
    population = next(
        (d for d in by_key.values() if d["domain"] == "population" and d["path"] == option["path"]),
        None,
    )
    if population is not None and population["status"] in {"unresolved", "invalid"}:
        reasons.append(_decision_fact(population))
        reasons.append(
            reason(
                "rule",
                "input_unknown",
                f"{population['option_key']} has no resolved population choice yet.",
            )
        )
        return "unknown", reasons
    if population is not None and population["status"] == "resolved":
        reasons.append(_decision_fact(population))
        revision_id = population["choice"]["revision"]["revision_id"]
        option_id = population["choice"].get("population_option_id")
        origin = f"chosen by {population['option_key']}"
    else:
        revision_id = (option["base"] or {}).get("population_revision_id")
        option_id = None
        origin = "of the target assembly occurrence (no population choice)"
    want = declared.get("population_revision_id")
    if want is None:
        reasons.append(
            reason(
                "fact",
                "target_undeclared",
                "The chosen firmware declares no target population; compatibility is not assumed.",
            )
        )
        return "unknown", reasons
    if revision_id is None:
        reasons.append(
            reason("fact", "population_undeclared", "No population is known for this occurrence.")
        )
        return "unknown", reasons
    if want != revision_id:
        reasons.append(
            reason(
                "fact",
                "target_mismatch",
                f"Firmware declares population revision {want}; the population {origin} is "
                f"revision {revision_id}.",
            )
        )
        return "invalid", reasons
    declared_option = declared.get("option_id")
    if declared_option is not None and option_id is None:
        reasons.append(
            reason(
                "fact",
                "population_option_unknown",
                f"Firmware declares population option {declared_option}; the option in use "
                f"{origin} is not stated.",
            )
        )
        return "unknown", reasons
    if declared_option is not None and declared_option != option_id:
        reasons.append(
            reason(
                "fact",
                "target_option_mismatch",
                f"Firmware declares population option {declared_option}; the chosen option "
                f"is {option_id}.",
            )
        )
        return "invalid", reasons
    reasons.append(
        reason(
            "fact",
            "target_matches",
            f"Firmware declares population revision {want}"
            + (f" option {declared_option}" if declared_option else "")
            + f", matching the population {origin}.",
        )
    )
    return "valid", reasons


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
    for decision in decisions:
        if decision["domain"] != "firmware":
            continue
        outcome, reasons = _firmware_target_rule(decision, by_key)
        results.append(
            {
                "key": f"firmware-target-{decision['option_key']}",
                "label": f"Firmware target population for {decision['label']}",
                "kind": "firmware_target",
                "basis": "Built-in: firmware is built for one declared target population.",
                "rule": {
                    "kind": "firmware_target",
                    "builtin": True,
                    "option_key": decision["option_key"],
                },
                "outcome": outcome,
                "reasons": reasons,
                "facts": [],
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
