"""CFG-004: proposals show computed impact before adoption; unknown is never "no impact"."""

import copy

from specmate.design.models import Draft
from specmate.revision_upgrades.models import UpgradeApplication

from .conftest import op
from .test_assemblies import create as create_assembly
from .test_assemblies import freeze, occ
from .test_cables import capture, create, fixture
from .test_facts import append, fact, subject
from .test_revision_upgrades import fixture as connector_fixture  # noqa: F401


def recorded(user, revision_id, citation):
    return append(
        user,
        subject(user, {"kind": "revision", "revision_id": revision_id}),
        fact(
            "continuity_checked",
            role="actual",
            value={"kind": "boolean", "value": True},
            provenance={
                "method": "source_observation",
                "evidence": [{"kind": "citation", "citation": citation}],
            },
        ),
    )["assertion"]["assertion_id"]


def cable_upgrade(users, project):
    owner = users["owner"]
    *_, cable = fixture(owner, project)
    draft = create(owner, project, cable)
    old = capture(owner, draft)
    changed = copy.deepcopy(cable)
    changed["assignments"][1]["contact_id"] = "a"
    changed["assignments"][1]["basis"] = "Synthetic change: right end moved to contact a"
    updated = op(
        owner,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": changed},
        expected_state=old["draft"]["state"],
    )
    candidate = capture(owner, updated)
    kit = freeze(owner, create_assembly(owner, project, [occ("jumper", old, "W1")]))
    old_fact = recorded(owner, old["revision_id"], "Synthetic continuity note for r1")
    kit_fact = recorded(owner, kit["revision_id"], "Synthetic kit check for r1")
    proposal = op(
        owner,
        "upgrade.propose",
        {
            "owning_snapshot_id": kit["snapshot_id"],
            "old_revision_id": old["revision_id"],
            "candidate_revision_id": candidate["revision_id"],
            "paths": [["jumper"]],
            "basis": "Inspect changed termination.",
        },
    )
    return proposal, old, candidate, old_fact, kit_fact


def test_cable_upgrade_shows_sections_disciplines_and_stale_evidence(users, project):
    proposal, old, candidate, old_fact, kit_fact = cable_upgrade(users, project)
    drafts = Draft.objects.count()
    # A viewer reads the same derived impact; reading never adopts anything.
    read = op(users["viewer"], "upgrade.read", {"proposal_id": proposal["proposal_id"]})
    assert Draft.objects.count() == drafts and not UpgradeApplication.objects.exists()
    impact = read["computed_impact"]
    assert impact == proposal["computed_impact"]
    assert impact["adopted"] is False and impact["derived_on_read"] is True
    assert impact["adapter"]["status"] == "computed"
    assert [s["section"] for s in impact["sections"]] == ["terminations"]
    assert impact["content"]["changed_sections"] == ["cable.assignments"]
    disciplines = impact["disciplines"]
    assert disciplines["electrical"]["status"] == "changed"
    assert disciplines["electrical"]["sections"] == ["terminations"]
    assert disciplines["manufacturing"]["status"] == "changed"
    # Mechanical was compared but nothing mapped to it changed; firmware was not compared.
    assert disciplines["mechanical"]["status"] == "no_difference_found"
    assert "not evaluated" in disciplines["mechanical"]["reason"]
    assert disciplines["firmware"]["status"] == "not_evaluated"
    assert disciplines["firmware"]["reason"]
    assert disciplines["evidence"]["status"] == "changed"
    stale = impact["evidence"]["becomes_stale"]
    assert [i["evidence_id"] for i in stale["items"]] == [f"fact:{old_fact}"]
    [item] = stale["items"]
    assert item["applicability"] == "stale_earlier_revision"
    assert item["evidence_revision_number"] == 1
    assert item["changed_sections"] == ["cable.assignments"]
    consumer = impact["evidence"]["consumer_stale"]
    assert [i["evidence_id"] for i in consumer["items"]] == [f"fact:{kit_fact}"]
    # Pins display a name and revision number; the exact revision ID stays alongside.
    [use] = [o for o in read["occurrences"] if o["selected"]]
    assert use["old_pin"]["name"] == "Synthetic cable" and use["old_pin"]["number"] == 1
    assert use["old_pin"]["revision_id"] == old["revision_id"] == use["old_revision_id"]
    assert use["candidate_pin"]["number"] == 2
    assert use["candidate_pin"]["revision_id"] == candidate["revision_id"]


def test_other_kinds_compare_content_and_mark_disciplines_not_evaluated(users, connector_fixture):  # noqa: F811
    payload, _ = connector_fixture
    proposal = op(users["owner"], "upgrade.propose", payload)
    impact = proposal["computed_impact"]
    assert impact["kind"] == "connector_body"
    assert impact["adapter"]["status"] == "not_available"
    assert impact["sections"] == []
    assert impact["content"]["content_changed"] is True
    assert impact["content"]["changed_sections"]
    for discipline in ("electrical", "mechanical", "firmware", "manufacturing"):
        assert impact["disciplines"][discipline]["status"] == "not_evaluated"
        assert "connector_body" in impact["disciplines"][discipline]["reason"]
    # No readable evidence is recorded: reported as none found, never as no impact.
    assert impact["disciplines"]["evidence"]["status"] == "none_found"
    assert impact["evidence"]["becomes_stale"]["total"] == 0
