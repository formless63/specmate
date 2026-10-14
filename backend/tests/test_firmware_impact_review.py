"""Independent authority and bounded-discovery checks for inert impact review."""

import copy

import pytest

from specmate.facts.models import FactAssertion
from specmate.firmware_impact import operations
from specmate.operations import NotFound, ValidationFailed

from .conftest import member, op, remove_member
from .scope_helpers import workspace_of
from .test_facts import append, fact, subject
from .test_firmware import attempt, board, digest, intake, recipe, source, sources  # noqa: F401
from .test_firmware_impact import compare, observation, payload
from .test_firmware_occurrences import frozen_firmware, pair  # noqa: F401
from .test_physical_units import unit_payload
from .test_sources import register


@pytest.mark.parametrize("physical", [False, True], ids=["revision", "actual-unit"])
def test_automatic_fact_input_ancestor_denial_precedes_assignment_diagnostic(
    users,
    project,
    pair,  # noqa: F811
    physical,
):
    assembly, first, second = pair
    snapshot = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )["snapshot_id"]
    content = b"Independent synthetic observation source."
    register(users["owner"], project, content)
    original = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Original evidence",
            "files": [
                {
                    "path": "reading.txt",
                    "sha256": digest(content),
                    "media_type": "text/plain",
                    "rights": "CC0-1.0",
                }
            ],
        },
    )
    derivative = op(
        users["owner"],
        "source.derive_bundle",
        {
            "source_revision_id": original["revision_id"],
            "name": "Reviewed evidence",
        },
    )
    evidence = append(
        users["owner"],
        subject(
            users["owner"],
            {
                "kind": "project",
                "project_id": project,
            },
        ),
        fact(
            provenance={
                "method": "source_observation",
                "evidence": [
                    {
                        "kind": "source_file",
                        "bundle_revision_id": derivative["revision_id"],
                        "path": "reading.txt",
                    }
                ],
            }
        ),
    )["assertion"]
    target = {"kind": "revision", "revision_id": first["revision_id"]}
    if physical:
        unit = op(
            users["owner"],
            "physical_units.register",
            unit_payload(first["revision_id"], "SYNTH-REVIEW-UNIT"),
            idempotency_key="impact-review-unit",
        )
        target = {"kind": "physical_unit", "unit_id": unit["unit_id"]}
    recorded = append(
        users["owner"],
        subject(users["owner"], target),
        fact(
            "derived_observation",
            provenance={
                "method": "calculation",
                "formula": "x",
                "algorithm_version": "synthetic-v1",
                "evidence": [
                    {
                        "kind": "assertion",
                        "assertion_id": evidence["assertion_id"],
                    }
                ],
            },
        ),
    )["assertion"]
    before = copy.deepcopy(list(FactAssertion.objects.order_by("id").values()))
    valid = payload(project, first, second)
    initial = compare(users, valid)
    assert [row["assertion"]["assertion_id"] for row in initial["observations"]] == [
        recorded["assertion_id"]
    ]
    wrong = copy.deepcopy(valid)
    wrong["candidate"].update(assembly_snapshot_id=snapshot, path=["left", "board"])
    with pytest.raises(ValidationFailed, match="not assigned"):
        compare(users, wrong)
    # Workspace membership loss hides the retained ancestry before the assignment
    # diagnostic and for the valid request alike; restoring it restores the exact result.
    remove_member(users["viewer"], project=project)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        compare(users, wrong)
    with pytest.raises(NotFound):
        compare(users, valid)
    member(users["viewer"], "viewer", project=project)
    assert compare(users, valid) == initial
    assert list(FactAssertion.objects.order_by("id").values()) == before


def test_oversized_automatic_discovery_does_not_materialize_entire_history(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
    monkeypatch,
):
    frozen = frozen_firmware(users, project, sources, board)
    for index in range(5):
        observation(
            users,
            {
                "kind": "revision",
                "revision_id": frozen["revision_id"],
                "feature_id": f"reading-{index}",
            },
        )
    # Exercise the same boundary with a small controlled history. Only one sentinel
    # beyond the supported count is needed to reject; no partial comparison is returned.
    monkeypatch.setattr(operations, "MAX_ASSERTIONS", 2)
    loaded = []
    original = FactAssertion.from_db

    def track(*args, **kwargs):
        row = original(*args, **kwargs)
        loaded.append(row.id)
        return row

    monkeypatch.setattr(FactAssertion, "from_db", track)
    with pytest.raises(ValidationFailed, match="limit"):
        compare(users, payload(project, frozen, frozen))
    assert len(loaded) <= 3
    assert FactAssertion.objects.count() == 5
