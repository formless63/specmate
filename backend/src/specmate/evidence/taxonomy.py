"""Shared evidence-kind taxonomy.

Source modules stay authoritative for their own records. This module only names what
kind of statement a record is, what it can support and what it must never be shown as.
No kind is a generic "passed": a requirement states intent, a claim reports a source,
a calculation derives from inputs, a generated check reports a tool receipt, a review
records a human association, and only a physical measurement observes an actual unit.
"""

from typing import Literal

Kind = Literal[
    "requirement",
    "source_claim",
    "calculation",
    "generated_check",
    "review",
    "physical_measurement",
    "physical_observation",
    "preference",
]

KIND_INFO: dict[str, dict] = {
    "requirement": {
        "label": "Requirement",
        "subject_scope": "design",
        "summary": "A stated need or test intent. It says what should hold or be checked.",
        "establishes": ["What a design is intended to satisfy or what a test should examine."],
        "does_not_establish": [
            "That the intent is satisfied.",
            "That any physical test was performed.",
            "Qualification of any actual unit.",
        ],
    },
    "source_claim": {
        "label": "Declared claim",
        "subject_scope": "either",
        "summary": (
            "A value reported by a citation or a registered source file, including a manually "
            "entered rating. The claim is retained, not verified."
        ),
        "establishes": ["That the stated source reported this value under the stated conditions."],
        "does_not_establish": [
            "That the value was measured.",
            "That a citation or manual entry was independently verified.",
            "That an actual unit meets the rating.",
        ],
    },
    "calculation": {
        "label": "Calculation",
        "subject_scope": "design",
        "summary": (
            "A value derived by a stated formula and algorithm version from input assertions."
        ),
        "establishes": ["What follows from the exact input assertions if they are correct."],
        "does_not_establish": [
            "That the inputs are true.",
            "That an actual unit behaves as calculated.",
        ],
    },
    "generated_check": {
        "label": "Generated check",
        "subject_scope": "design",
        "summary": "A tool or automated check receipt over exact retained inputs and a recipe.",
        "establishes": [
            "That the named recipe ran over the named inputs and reported this outcome."
        ],
        "does_not_establish": [
            "That a successful run is physical qualification.",
            "Fitness beyond what the recipe evaluates.",
        ],
    },
    "review": {
        "label": "Review",
        "subject_scope": "either",
        "summary": "A human review or reviewed association recorded by an accountable actor.",
        "establishes": ["That a reviewer accepted the association or finding as stated."],
        "does_not_establish": [
            "That anything was measured.",
            "Approval beyond the stated scope.",
        ],
    },
    "physical_measurement": {
        "label": "Physical measurement",
        "subject_scope": "actual",
        "summary": (
            "An observation of an actual physical unit with instrument, procedure and time."
        ),
        "establishes": ["What was observed on that unit, with that instrument, at that time."],
        "does_not_establish": [
            "Behavior of other units, lots or populations.",
            "Release or qualification of a design.",
        ],
    },
    "physical_observation": {
        "label": "Physical observation",
        "subject_scope": "actual",
        "summary": (
            "An unmeasured statement about an actual unit, such as an observed or declared "
            "status without instrument or procedure."
        ),
        "establishes": ["That someone declared or observed this status of that unit."],
        "does_not_establish": [
            "A measurement: no instrument or procedure is recorded.",
            "Qualification of the unit.",
        ],
    },
    "preference": {
        "label": "Preference",
        "subject_scope": "either",
        "summary": "A declared choice. It is not an engineering rating or evidence of fitness.",
        "establishes": ["What was preferred."],
        "does_not_establish": ["Any rating, capability or compliance."],
    },
}

# Fact methods are authoritative in the facts module; this is only their shared reading.
FACT_METHOD_KIND = {
    "source_observation": "source_claim",
    "reviewed_association": "review",
    "calculation": "calculation",
    "measurement": "physical_measurement",
    "preference": "preference",
}
KIND_FACT_METHODS = {
    kind: [method for method, mapped in FACT_METHOD_KIND.items() if mapped == kind]
    for kind in KIND_INFO
}


def fact_kind(method: str, subject_kind: str) -> tuple[str, list[str]]:
    """Return the shared kind and warnings for one fact method on one subject kind."""
    kind = FACT_METHOD_KIND[method]
    if kind == "physical_measurement" and subject_kind != "physical_unit":
        # The write path rejects this; legacy rows must never read as physical evidence.
        return "source_claim", [
            "Recorded as a measurement of a non-physical subject; shown as a declared claim."
        ]
    return kind, []


def taxonomy() -> dict:
    return {
        "kinds": [
            {"kind": kind, **info, "fact_methods": KIND_FACT_METHODS[kind]}
            for kind, info in KIND_INFO.items()
        ]
    }
