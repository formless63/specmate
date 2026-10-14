"""ACC-CFG-002: explainable constraint outcomes with fact- and rule-level reasons.

A missing current rating stays unknown rather than solver-assumed compatibility.
Synthetic generic definitions and fact ledgers on real PostgreSQL; no native tool runs
and no outcome is physical qualification.
"""

# ruff: noqa: F811
import pytest

from specmate.builds.models import BuildAttempt
from specmate.configurations.models import ResolvedConfiguration
from specmate.design.models import Draft
from specmate.operations import Conflict, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_builds import build_payload, recipe, source  # noqa: F401
from .test_configurations import capture, configuration, frozen, option_set_content, select


def rating(magnitude=None, unit="A", **changes):
    content = {
        "property": "current_rating",
        "status": "known",
        "purpose": "rating",
        "role": "upper_bound",
        "value": {"kind": "quantity", "dimension": "current", "unit": unit, "magnitude": magnitude},
        "basis": "Synthetic datasheet rating; no physical qualification.",
        "provenance": {
            "method": "source_observation",
            "evidence": [{"kind": "citation", "citation": "Synthetic datasheet, table 1."}],
        },
    }
    content.update(changes)
    if content["status"] != "known":
        content.pop("value", None)
    return content


def ledger(user, revision_id):
    return op(
        user, "facts.register_subject", {"target": {"kind": "revision", "revision_id": revision_id}}
    )


def append(user, subject, content):
    return op(
        user,
        "facts.append",
        {"subject_id": subject["subject_id"], "fact": content},
        expected_state=subject["state"],
    )


CURRENT = {
    "kind": "fact_limit",
    "key": "sensor-current",
    "label": "Sensor carries the supply current",
    "basis": "Synthetic supply demand of 2 A.",
    "option_key": "sensor",
    "property": "current_rating",
    "role": "upper_bound",
    "comparison": "at_least",
    "limit": {"kind": "quantity", "dimension": "current", "unit": "mA", "magnitude": "2000"},
}
PAINT_NEEDS_SPLASH = {
    "kind": "requires",
    "key": "paint-sealing",
    "label": "Painted finish needs splash sealing",
    "basis": "Synthetic process note.",
    "when": {"option_key": "finish", "choice_key": "paint"},
    "option_key": "sealing",
    "choice_keys": ["splash"],
}
BEAD_EXCLUDES_B = {
    "kind": "excludes",
    "key": "bead-sensor",
    "label": "Bead blast excludes sensor B",
    "basis": "Synthetic process note.",
    "when": {"option_key": "finish", "choice_key": "bead"},
    "option_key": "sensor",
    "choice_keys": ["b"],
}


def constrained(user, project, parts, rules):
    content = option_set_content(parts)
    content["option_set"]["constraints"] = rules
    created = op(
        user,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "option_set",
            "name": "Synthetic constrained options",
            "content": content,
        },
    )
    revision = op(
        user, "draft.freeze", {"draft_id": created["draft_id"]}, expected_state=created["state"]
    )
    return revision["revision_id"]


@pytest.fixture
def parts(users, project):
    return [frozen(users["owner"], project, f"Synthetic sensor {n}") for n in ("A", "B")]


def results(preview):
    return {r["key"]: r for r in preview["resolution"]["constraints"]["results"]}


def codes(result, level):
    return [r["code"] for r in result["reasons"] if r["level"] == level]


def resolve(user, draft):
    return op(user, "configuration.resolve", {"draft_id": draft["draft_id"]})


def test_missing_current_rating_stays_unknown_and_known_ratings_decide(users, project, parts):
    revision = constrained(users["owner"], project, parts, [CURRENT])
    draft = configuration(users["editor"], project, revision)
    preview = resolve(users["viewer"], draft)
    constraints = preview["resolution"]["constraints"]
    current = results(preview)["sensor-current"]
    # ACC-CFG-002: no recorded rating is unknown, never assumed compatible.
    assert current["outcome"] == "unknown"
    assert codes(current, "rule") == ["fact_limit"]
    assert codes(current, "fact") == ["decision_resolved", "fact_missing"]
    assert current["facts"] == []
    assert constraints["outcome"] == "unknown"
    assert constraints["counts"] == {"valid": 0, "invalid": 0, "unknown": 1, "not_evaluated": 0}
    assert preview["resolution"]["compatibility"] == "not_evaluated"
    assert preview["resolution"]["physical_qualification"] is False

    # A ledger with only an explicit unknown, or another purpose, is still unknown.
    a = ledger(users["editor"], parts[0]["revision_id"])
    a = append(users["editor"], a, rating(status="unknown"))
    a = append(users["editor"], a, rating("9", purpose="general"))
    current = results(resolve(users["viewer"], draft))["sensor-current"]
    assert current["outcome"] == "unknown"
    assert codes(current, "fact")[-1] == "fact_unknown"
    assert current["facts"][0]["status"] == "unknown"

    # A known 3 A rating meets the 2000 mA limit, citing its exact assertion.
    b = ledger(users["editor"], parts[1]["revision_id"])
    b = append(users["editor"], b, rating("3"))
    select(users["editor"], draft, [{"option_key": "sensor", "choice_key": "b"}])
    current = results(resolve(users["viewer"], draft))["sensor-current"]
    assert current["outcome"] == "valid"
    fact_reason = current["reasons"][-1]
    assert fact_reason["code"] == "fact_satisfies"
    assert fact_reason["assertion_ids"] == current["facts"][0]["assertion_ids"]
    assert current["facts"][0]["value"] == {
        "kind": "quantity",
        "dimension": "current",
        "unit": "A",
        "magnitude": "3",
    }
    b = append(users["editor"], b, rating("1.5"))
    current = results(resolve(users["viewer"], draft))["sensor-current"]
    # Two disagreeing ratings conflict; the conflict is unknown, not the higher value.
    assert current["outcome"] == "unknown"
    assert codes(current, "fact")[-1] == "fact_conflicting"
    assert len(current["facts"][0]["assertion_ids"]) == 2

    low = frozen(users["owner"], project, "Synthetic sensor low")
    append(users["editor"], ledger(users["editor"], low["revision_id"]), rating("1500", unit="mA"))
    low_revision = constrained(users["owner"], project, [low, parts[1]], [CURRENT])
    low_draft = configuration(users["editor"], project, low_revision)
    current = results(resolve(users["viewer"], low_draft))["sensor-current"]
    assert current["outcome"] == "invalid"
    assert codes(current, "fact")[-1] == "fact_violates"
    assert resolve(users["viewer"], low_draft)["resolution"]["constraints"]["outcome"] == "invalid"


def test_ranges_conditions_and_incomparable_facts_never_become_valid(users, project, parts):
    text_part = frozen(users["owner"], project, "Synthetic sensor C")
    rule = {**CURRENT, "key": "actual-current", "role": "actual"}
    revision = constrained(users["owner"], project, parts, [rule])
    draft = configuration(users["editor"], project, revision)
    a = ledger(users["editor"], parts[0]["revision_id"])
    straddle = rating(role="actual")
    straddle["value"] = {
        "kind": "range",
        "dimension": "current",
        "unit": "A",
        "lower": "1",
        "upper": "3",
    }
    a = append(users["editor"], a, straddle)
    current = results(resolve(users["viewer"], draft))["actual-current"]
    assert current["outcome"] == "unknown"
    assert codes(current, "fact")[-1] == "fact_range_straddles"

    b = ledger(users["editor"], parts[1]["revision_id"])
    temperature = {
        "property": "temperature",
        "status": "known",
        "value": {
            "kind": "quantity",
            "dimension": "temperature",
            "unit": "degC",
            "magnitude": "25",
        },
    }
    append(users["editor"], b, rating("5", role="actual", conditions=[temperature]))
    select(users["editor"], draft, [{"option_key": "sensor", "choice_key": "b"}])
    current = results(resolve(users["viewer"], draft))["actual-current"]
    assert current["outcome"] == "unknown"
    assert codes(current, "fact")[-1] == "conditions_only"

    text = rating(role="actual")
    text["value"] = {"kind": "text", "text": "high"}
    append(users["editor"], ledger(users["editor"], text_part["revision_id"]), text)
    revision = constrained(users["owner"], project, [text_part, parts[1]], [rule])
    other = configuration(users["editor"], project, revision)
    current = results(resolve(users["viewer"], other))["actual-current"]
    assert current["outcome"] == "not_evaluated"
    assert codes(current, "fact")[-1] == "incomparable"


def test_choice_rules_applicability_and_declared_values(users, project, parts):
    rules = [
        PAINT_NEEDS_SPLASH,
        BEAD_EXCLUDES_B,
        {**CURRENT, "key": "finish-current", "option_key": "finish", "when": None},
    ]
    revision = constrained(users["owner"], project, parts, rules)
    draft = configuration(users["editor"], project, revision)
    by_key = results(resolve(users["viewer"], draft))
    # finish is required and unresolved: applicability of both choice rules is unknown.
    assert by_key["paint-sealing"]["outcome"] == "unknown"
    assert codes(by_key["paint-sealing"], "rule") == ["applicability_unknown"]
    assert by_key["bead-sensor"]["outcome"] == "unknown"
    assert by_key["finish-current"]["outcome"] == "unknown"

    select(users["editor"], draft, [{"option_key": "finish", "choice_key": "paint"}])
    preview = resolve(users["viewer"], draft)
    by_key = results(preview)
    # Painted without the optional splash sealing violates the explicit rule.
    assert by_key["paint-sealing"]["outcome"] == "invalid"
    assert codes(by_key["paint-sealing"], "rule") == ["applicable", "choice_requires"]
    assert codes(by_key["paint-sealing"], "fact") == ["decision_resolved", "decision_none"]
    assert by_key["bead-sensor"]["outcome"] == "not_evaluated"
    assert codes(by_key["bead-sensor"], "rule") == ["not_applicable"]
    # A declared value is not an exact revision and records no facts.
    assert by_key["finish-current"]["outcome"] == "not_evaluated"
    assert codes(by_key["finish-current"], "rule")[-1] == "declared_value"
    assert preview["resolution"]["constraints"]["outcome"] == "invalid"

    select(
        users["editor"],
        draft,
        [
            {"option_key": "finish", "choice_key": "paint"},
            {"option_key": "sealing", "choice_key": "splash"},
        ],
    )
    preview = resolve(users["viewer"], draft)
    assert results(preview)["paint-sealing"]["outcome"] == "valid"
    # valid + not evaluated only: overall valid, with every count reported.
    assert preview["resolution"]["constraints"]["outcome"] == "valid"
    assert preview["resolution"]["constraints"]["counts"] == {
        "valid": 1,
        "invalid": 0,
        "unknown": 0,
        "not_evaluated": 2,
    }

    select(
        users["editor"],
        draft,
        [
            {"option_key": "finish", "choice_key": "bead"},
            {"option_key": "sensor", "choice_key": "b"},
        ],
    )
    assert results(resolve(users["viewer"], draft))["bead-sensor"]["outcome"] == "invalid"


def test_capture_pins_evaluated_facts_and_build_input_reports_outcome(users, project, parts):
    revision = constrained(users["owner"], project, parts, [CURRENT])
    draft = configuration(users["editor"], project, revision)
    select(users["editor"], draft, [{"option_key": "finish", "choice_key": "bead"}])
    reviewed = resolve(users["editor"], draft)
    # A fact appended after review changes the evaluated evidence: capture conflicts.
    a = ledger(users["editor"], parts[0]["revision_id"])
    a = append(users["editor"], a, rating("2"))
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "configuration.capture",
            {
                "draft_id": draft["draft_id"],
                "review_sha256": reviewed["review_sha256"],
                "basis": "Reviewed before the rating was recorded",
            },
            expected_state=reviewed["state"],
        )
    captured = capture(users["editor"], draft["draft_id"])
    current = {r["key"]: r for r in captured["resolution"]["constraints"]["results"]}
    assert current["sensor-current"]["outcome"] == "valid"
    pinned = current["sensor-current"]["facts"][0]
    assert pinned["subject_state"] == a["state"]

    # A later conflicting rating changes the live preview, never the captured result.
    append(users["editor"], a, rating("1"))
    assert results(resolve(users["viewer"], draft))["sensor-current"]["outcome"] == "unknown"
    stored = ResolvedConfiguration.objects.get(id=captured["resolved_configuration_id"])
    assert stored.resolution["constraints"]["outcome"] == "valid"
    built = op(
        users["viewer"],
        "configuration.build_input",
        {"resolved_configuration_id": captured["resolved_configuration_id"]},
    )
    assert built["constraints"] == {
        "outcome": "valid",
        "counts": {"valid": 1, "invalid": 0, "unknown": 0, "not_evaluated": 0},
        "unknown": [],
        "invalid": [],
    }
    assert built["physical_qualification"] is False


def test_invalid_rule_content_is_rejected(users, project, parts):
    def create(rules):
        content = option_set_content(parts)
        content["option_set"]["constraints"] = rules
        return op(
            users["owner"],
            "definition.create",
            {
                "workspace_id": workspace_of(project),
                "kind": "option_set",
                "name": "Synthetic invalid rules",
                "content": content,
            },
        )

    ranged = {
        **CURRENT,
        "limit": {"kind": "range", "dimension": "current", "unit": "A", "lower": "1", "upper": "2"},
    }
    for rules in (
        [CURRENT, CURRENT],
        [{**CURRENT, "option_key": "colour"}],
        [{**PAINT_NEEDS_SPLASH, "choice_keys": ["dry"]}],
        [{**PAINT_NEEDS_SPLASH, "when": {"option_key": "finish", "choice_key": "chrome"}}],
        [{**PAINT_NEEDS_SPLASH, "option_key": "finish", "choice_keys": ["bead"]}],
        [ranged],
        [{**CURRENT, "role": "tolerance"}],
        [{**CURRENT, "purpose": "preference"}],
        [{**CURRENT, "limit": {**CURRENT["limit"], "unit": "V"}}],
    ):
        with pytest.raises(ValidationFailed):
            create(rules)
    # A valid rule set round-trips in the stored option-set content.
    created = create([CURRENT, PAINT_NEEDS_SPLASH])
    draft = Draft.objects.get(id=created["draft_id"])
    keys = [rule["key"] for rule in draft.content["option_set"]["constraints"]]
    assert keys == ["sensor-current", "paint-sealing"]


def test_invalid_outcome_is_captured_but_refused_as_build_input(
    users, project, parts, build_payload
):
    revision = constrained(users["owner"], project, parts, [PAINT_NEEDS_SPLASH, CURRENT])
    draft = configuration(users["editor"], project, revision)
    select(users["editor"], draft, [{"option_key": "finish", "choice_key": "paint"}])
    # Recording is allowed for every outcome; the invalid rule is retained as evidence.
    invalid = capture(users["editor"], draft["draft_id"])
    assert invalid["resolution"]["constraints"]["outcome"] == "invalid"
    with pytest.raises(ValidationFailed) as refused:
        op(
            users["viewer"],
            "configuration.build_input",
            {"resolved_configuration_id": invalid["resolved_configuration_id"]},
        )
    assert refused.value.details == {"invalid": ["paint-sealing"]}
    with pytest.raises(ValidationFailed) as refused:
        op(
            users["owner"],
            "build.request",
            {**build_payload, "resolved_configuration_id": invalid["resolved_configuration_id"]},
            idempotency_key="invalid-constraints",
        )
    assert refused.value.details == {"invalid": ["paint-sealing"]}
    assert not BuildAttempt.objects.exists()

    # Unknown (the current rating is missing) stays buildable, with its outcome visible.
    select(
        users["editor"],
        draft,
        [
            {"option_key": "finish", "choice_key": "paint"},
            {"option_key": "sealing", "choice_key": "splash"},
        ],
    )
    unknown = capture(users["editor"], draft["draft_id"])
    built = op(
        users["viewer"],
        "configuration.build_input",
        {"resolved_configuration_id": unknown["resolved_configuration_id"]},
    )
    assert built["constraints"]["outcome"] == "unknown"
    assert built["constraints"]["unknown"] == ["sensor-current"]
    listed = op(
        users["viewer"], "configuration.list_resolved", {"workspace_id": workspace_of(project)}
    )
    outcomes = {r["resolved_configuration_id"]: r["constraint_outcome"] for r in listed["resolved"]}
    assert outcomes == {
        invalid["resolved_configuration_id"]: "invalid",
        unknown["resolved_configuration_id"]: "unknown",
    }
