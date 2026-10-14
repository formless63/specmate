"""ACC-CFG-003 with an existing mechanical (enclosure) proposal linked to a failing rule.

Board extraction is simulated as in the other proposal tests; no native tool runs.
"""

# ruff: noqa: F811
import pytest

from specmate.mechanical_proposals import operations as proposals
from specmate.operations import NotFound

from .conftest import op
from .test_configuration_constraints import PAINT_NEEDS_SPLASH, constrained
from .test_configurations import configuration, frozen, select
from .test_mechanical_proposal_generators import FULL
from .test_mechanical_proposals import board, create  # noqa: F401
from .test_pcb import recipe, source  # noqa: F401


def test_linked_enclosure_proposal_is_reported_and_never_validates(
    users, project, workspace, board, monkeypatch
):
    parts = [frozen(users["owner"], project, f"Synthetic sensor {n}") for n in ("A", "B")]
    revision = constrained(users["owner"], project, parts, [PAINT_NEEDS_SPLASH])
    draft = configuration(users["editor"], project, revision)
    select(users["editor"], draft, [{"option_key": "finish", "choice_key": "paint"}])
    proposal = create(users["editor"], workspace, board, FULL, name="Synthetic sealed lid")
    retained = op(
        users["editor"],
        "mechanical_proposal.retain",
        {"draft_id": proposal["draft_id"]},
        expected_state=proposal["state"],
    )
    decisions = op(
        users["viewer"],
        "mechanical_proposal.read_retained",
        {"revision_id": retained["revision_id"]},
    )
    op(
        users["editor"],
        "mechanical_proposal.decide",
        {
            "revision_id": retained["revision_id"],
            "decision": "accepted",
            "reason": "Synthetic acceptance of the proposal.",
            "draft_name": "Synthetic sealed lid design",
        },
        expected_state=decisions["decision_state"],
    )
    linked = op(
        users["contributor"],
        "configuration.link_development",
        {
            "draft_id": draft["draft_id"],
            "rule_key": "paint-sealing",
            "target": {"kind": "mechanical_proposal", "proposal_draft_id": proposal["draft_id"]},
            "basis": "A sealed lid may meet the splash requirement.",
        },
    )
    target = linked["target"]
    assert target["readable"] is True and target["name"] == "Synthetic sealed lid"
    assert target["current_decision"] == "accepted"
    assert target["latest_retained"]["number"] == 1

    # Even an accepted enclosure proposal leaves the combination invalid.
    preview = op(users["viewer"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    assert preview["resolution"]["constraints"]["outcome"] == "invalid"
    assert preview["development"]["outcome"] == "invalid_with_proposal"

    # Without current board-source authority the proposal is listed but not named.
    def unreadable(*args, **kwargs):
        raise NotFound("Proposal draft not found.")

    monkeypatch.setattr(proposals, "authorized_draft", unreadable)
    hidden = op(users["viewer"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    entry = hidden["development"]["links"][0]["target"]
    assert entry == {
        "kind": "mechanical_proposal",
        "readable": False,
        "proposal_draft_id": proposal["draft_id"],
    }
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "configuration.link_development",
            {
                "draft_id": draft["draft_id"],
                "rule_key": "paint-sealing",
                "target": {
                    "kind": "mechanical_proposal",
                    "proposal_draft_id": proposal["draft_id"],
                },
                "basis": "Second link attempt.",
            },
        )
