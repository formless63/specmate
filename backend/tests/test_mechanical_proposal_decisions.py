"""Append-only review decisions on retained mechanical proposals."""

import pytest
from django.db import DatabaseError, transaction

from specmate.design.models import Definition, Draft
from specmate.mechanical_proposals.models import ProposalDecision, ProposalRevision
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_mechanical_proposals import board, create  # noqa: F401
from .test_pcb import recipe, source  # noqa: F401


@pytest.fixture
def retained(users, workspace, board):  # noqa: F811
    draft = create(users["editor"], workspace, board)
    return op(
        users["editor"],
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )


def decide(user, retained, decision, state, reason="Reviewed.", **extra):
    ctx = {"idempotency_key": extra.pop("key")} if "key" in extra else {}
    return op(
        user,
        "mechanical_proposal.decide",
        {"revision_id": retained["revision_id"], "decision": decision, "reason": reason, **extra},
        expected_state=state,
        **ctx,
    )


def read(user, retained):
    return op(user, "mechanical_proposal.read_retained", {"revision_id": retained["revision_id"]})


def test_defer_then_reject_appends_and_leaves_retained_bytes_untouched(users, retained):
    before = ProposalRevision.objects.get(id=retained["revision_id"])
    assert read(users["viewer"], retained)["current_decision"] is None
    assert read(users["viewer"], retained)["decision_state"] == "decision-v0"
    first = decide(users["editor"], retained, "deferred", "decision-v0", "Need a wall value.")
    assert first["decision_state"] == "decision-v1"
    second = decide(users["editor"], retained, "rejected", "decision-v1", "Wrong board.")
    view = read(users["viewer"], retained)
    assert [d["decision"] for d in view["decisions"]] == ["deferred", "rejected"]
    assert view["current_decision"]["reason"] == "Wrong board."
    assert second["recorded"]["draft_id"] is None
    after = ProposalRevision.objects.get(id=retained["revision_id"])
    assert bytes(after.canonical) == bytes(before.canonical) and after.sha256 == before.sha256


def test_accept_creates_a_draft_through_design_operations_and_is_final(users, retained):
    count = (Definition.objects.count(), Draft.objects.count())
    result = decide(
        users["editor"], retained, "accepted", "decision-v0", draft_name="Housing from proposal"
    )
    recorded = result["recorded"]
    assert recorded["link_mode"] == "created"
    draft = Draft.objects.select_related("definition").get(id=recorded["draft_id"])
    assert (Definition.objects.count(), Draft.objects.count()) == (count[0] + 1, count[1] + 1)
    adoption = draft.content["proposal_adoption"]
    assert adoption["retained_proposal_id"] == retained["revision_id"]
    assert adoption["retained_sha256"] == retained["sha256"]
    assert adoption["physical_qualification"] is False
    with pytest.raises(Conflict):
        decide(users["editor"], retained, "rejected", "decision-v1")


def test_accept_links_an_existing_draft_without_editing_it(users, workspace, retained):
    created = op(
        users["editor"],
        "definition.create",
        {"workspace_id": workspace_of(workspace), "kind": "note", "name": "Target", "content": {}},
    )
    before = Draft.objects.get(id=created["draft_id"])
    result = decide(
        users["editor"], retained, "accepted", "decision-v0", link_draft_id=created["draft_id"]
    )
    assert result["recorded"]["link_mode"] == "linked"
    after = Draft.objects.get(id=created["draft_id"])
    assert (after.version, after.content) == (before.version, before.content)


def test_payload_shape_reason_and_stale_state(users, retained):
    for extra in (
        {"decision": "accepted"},
        {"decision": "accepted", "draft_name": "a", "link_draft_id": retained["draft_id"]},
        {"decision": "rejected", "draft_name": "a"},
        {"decision": "deferred", "reason": "   "},
        {"decision": "deferred", "reason": ""},
    ):
        payload = {"reason": "r", **extra}
        with pytest.raises(ValidationFailed):
            op(
                users["editor"],
                "mechanical_proposal.decide",
                {"revision_id": retained["revision_id"], **payload},
                expected_state="decision-v0",
            )
    decide(users["editor"], retained, "deferred", "decision-v0")
    with pytest.raises(Conflict):
        decide(users["editor"], retained, "rejected", "decision-v0")
    assert ProposalDecision.objects.count() == 1


def test_link_target_must_be_a_draft_in_this_workspace(users, other_workspace, retained):
    foreign = op(
        users["outsider"],
        "definition.create",
        {"workspace_id": workspace_of(other_workspace), "kind": "note", "name": "X", "content": {}},
    )
    with pytest.raises(NotFound):
        decide(
            users["editor"], retained, "accepted", "decision-v0", link_draft_id=foreign["draft_id"]
        )
    assert ProposalDecision.objects.count() == 0


def test_permissions_require_design_edit(users, retained):
    for name in ("viewer", "contributor"):
        with pytest.raises(PermissionDenied):
            decide(users[name], retained, "deferred", "decision-v0")
    with pytest.raises(NotFound):
        decide(users["outsider"], retained, "deferred", "decision-v0")
    assert ProposalDecision.objects.count() == 0


def test_idempotent_replay_returns_the_same_decision(users, retained):
    first = decide(users["editor"], retained, "deferred", "decision-v0", key="decide-1")
    again = decide(users["editor"], retained, "deferred", "decision-v0", key="decide-1")
    assert again["recorded"]["decision_id"] == first["recorded"]["decision_id"]
    assert ProposalDecision.objects.count() == 1


def test_database_guards_keep_decisions_append_only(users, retained):
    decide(users["editor"], retained, "deferred", "decision-v0")
    row = ProposalDecision.objects.get()
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalDecision.objects.filter(id=row.id).update(decision="accepted")
    with pytest.raises(DatabaseError), transaction.atomic():
        row.delete()
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalDecision.objects.create(
            revision_id=row.revision_id,
            workspace_id=row.workspace_id,
            version=5,
            decision="rejected",
            reason="skipped",
            decided_by_id=row.decided_by_id,
            request_id="x",
        )


def test_accepted_draft_pins_are_typed_and_immutable(users, workspace, retained):
    result = decide(users["editor"], retained, "accepted", "decision-v0", draft_name="Housing")
    draft_id = result["recorded"]["draft_id"]
    state = Draft.objects.get(id=draft_id).state_token
    pin = Draft.objects.get(id=draft_id).content["proposal_adoption"]
    for changes, remove in (
        ({"proposal_adoption": {**pin, "retained_sha256": "0" * 64}}, []),
        ({"proposal_adoption": {**pin, "physical_qualification": True}}, []),
        ({"extra": 1}, []),
        ({}, ["proposal_adoption"]),
    ):
        with pytest.raises(ValidationFailed):
            op(
                users["editor"],
                "draft.update",
                {"draft_id": draft_id, "changes": changes, "remove": remove},
                expected_state=state,
            )
    assert Draft.objects.get(id=draft_id).content["proposal_adoption"] == pin


def test_adoption_content_must_pin_a_real_retained_record(users, workspace):
    pin = {
        "retained_proposal_id": "00000000-0000-0000-0000-000000000001",
        "retained_sha256": "a" * 64,
        "proposal_draft_id": "00000000-0000-0000-0000-000000000002",
        "interpretation_id": "00000000-0000-0000-0000-000000000003",
        "interpretation_sha256": "b" * 64,
        "generator": "g",
        "status": "incomplete",
        "physical_qualification": False,
    }
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "definition.create",
            {
                "workspace_id": workspace_of(workspace),
                "kind": "enclosure_proposal",
                "name": "Forged",
                "content": {"proposal_adoption": pin},
            },
        )


def test_draft_targets_list_workspace_drafts_for_editors_only(users, workspace, retained):
    op(
        users["editor"],
        "definition.create",
        {"workspace_id": workspace_of(workspace), "kind": "note", "name": "T", "content": {}},
    )
    listed = op(users["editor"], "mechanical_proposal.draft_targets", {"workspace_id": workspace})
    assert [d["name"] for d in listed["drafts"]] == ["T"]
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "mechanical_proposal.draft_targets", {"workspace_id": workspace})
