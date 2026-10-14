"""KNW-002: reviewed replacement identities and nested consuming contexts.

Correspondence is always declared by a reviewer; label equality and catalog matching
associations never establish a replacement. Frozen consumers keep their exact pins.
"""

import pytest
from django.db import DatabaseError, transaction

from specmate.design.models import Draft, Revision, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unsupported,
    ValidationFailed,
)
from specmate.revision_upgrades.models import UpgradeApplication, UpgradeProposal, UpgradeReview

from .conftest import member, op, remove_member
from .test_assemblies import create, endpoint, freeze, occ, part
from .test_project_references import add
from .test_transports import api
from .test_wire_stock import workspace_of


def connector(user, project, name, contacts):
    body = op(
        user,
        "interface.create",
        {
            "project_id": project,
            "name": name,
            "interface": {
                "kind": "connector_body",
                "contacts": [{"contact_id": contact} for contact in contacts],
            },
        },
    )
    return op(
        user, "interface.freeze", {"draft_id": body["draft_id"]}, expected_state=body["state"]
    )


def link(local_id, a, b):
    return {"kind": "electrical", "local_id": local_id, "a": a, "b": b}


def frozen():
    return {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()}


@pytest.fixture
def pair(users, project):
    owner = users["owner"]
    old = connector(owner, project, "Synthetic two-way body", ["pin-a"])
    new = connector(owner, project, "Synthetic replacement body", ["c1", "c2"])
    return old, new


@pytest.fixture
def flat(users, project, pair):
    old, new = pair
    root = create(
        users["owner"],
        project,
        [occ("left", old), occ("right", old)],
        [
            link("link", endpoint(["left"], "pin-a"), endpoint(["right"], "pin-a")),
            {
                "kind": "mating",
                "local_id": "mate",
                "a": endpoint(["left"]),
                "b": endpoint(["right"]),
            },
        ],
    )
    owning = freeze(users["owner"], root)
    payload = {
        "owning_snapshot_id": owning["snapshot_id"],
        "old_revision_id": old["revision_id"],
        "candidate_revision_id": new["revision_id"],
        "relation": "declared_replacement",
        "replacement_basis": "Reviewer declares the replacement body for this use.",
        "paths": [["left"]],
        "basis": "Replace one synthetic body use.",
    }
    return payload, owning


def review(user, proposal, decision="accepted", **extra):
    return op(
        user,
        "upgrade.review",
        {
            "proposal_id": proposal["proposal_id"],
            "decision": decision,
            "basis": "Explicit declared correspondence only.",
            **extra,
        },
        expected_state=proposal["state"],
    )


def mapping(path, old, new):
    return {
        "path": path,
        "old_feature_id": old,
        "candidate_feature_id": new,
        "basis": "Reviewed synthetic contact correspondence.",
    }


def decision(local_id, value):
    return {"local_id": local_id, "decision": value, "basis": "Reviewed relationship use."}


def test_identity_relation_is_explicit_and_kind_preserving(users, project, flat, pair):
    payload, _ = flat
    owner = users["owner"]
    old, _ = pair
    for invalid in [
        {**payload, "relation": "later_revision", "replacement_basis": None},
        {**payload, "replacement_basis": None},
        {**payload, "relation": "later_revision"},
        {**payload, "candidate_revision_id": old["revision_id"]},
    ]:
        with pytest.raises(ValidationFailed):
            op(owner, "upgrade.propose", invalid)
    _, board = part(owner, project)
    with pytest.raises(Unsupported):
        op(owner, "upgrade.propose", {**payload, "candidate_revision_id": board["revision_id"]})
    assert not UpgradeProposal.objects.exists()


def test_declared_replacement_requires_decisions_and_correspondence(users, flat):
    payload, owning = flat
    owner = users["owner"]
    before = frozen()
    proposal = op(owner, "upgrade.propose", payload, idempotency_key="replace")
    assert proposal["relation"] == "declared_replacement"
    assert proposal["replacement_basis"] == payload["replacement_basis"]
    assert proposal["relationship_decisions_required"] == ["link", "mate"]
    assert proposal["affected_features"] == [{"path": ["left"], "feature_id": "pin-a"}]
    assert proposal["parent_propagation"] == {"status": "not_applicable"}
    assert proposal["compatibility"] == "not_evaluated"
    assert op(owner, "upgrade.propose", payload, idempotency_key="replace") == proposal
    with pytest.raises(IdempotencyMismatch):
        op(owner, "upgrade.propose", {**payload, "paths": [["right"]]}, idempotency_key="replace")
    complete = {
        "features": [mapping(["left"], "pin-a", "c2")],
        "relationships": [decision("link", "retain"), decision("mate", "remove")],
    }
    for incomplete in [
        {"features": complete["features"]},
        {**complete, "features": []},
        # Equal labels are not correspondence and the candidate declares no pin-a.
        {**complete, "features": [mapping(["left"], "pin-a", "pin-a")]},
        {**complete, "relationships": [*complete["relationships"], decision("link", "remove")]},
        {**complete, "relationships": [*complete["relationships"], decision("other", "retain")]},
        {**complete, "assignments": [{"path": ["left"], "decision": "retain", "basis": "None"}]},
        {**complete, "features": [mapping(["right"], "pin-a", "c2")]},
    ]:
        with pytest.raises(ValidationFailed):
            review(owner, proposal, **incomplete)
    assert not UpgradeReview.objects.exists()
    reviewed = review(owner, proposal, **complete)
    assert reviewed["reviews"][0]["relationship_decisions"][1]["decision"] == "remove"
    assert [r["local_id"] for r in reviewed["candidate_relationships"]] == ["link"]
    with pytest.raises(Conflict):
        review(owner, proposal, **complete)
    result = op(
        owner,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=reviewed["state"],
        idempotency_key="adopt",
    )
    assembly = result["content"]["assembly"]
    assert [o["revision_id"] for o in assembly["occurrences"]] == [
        payload["candidate_revision_id"],
        payload["old_revision_id"],
    ]
    assert assembly["relationships"] == [
        link("link", endpoint(["left"], "c2"), endpoint(["right"], "pin-a"))
    ]
    assert result["base_revision_id"] == owning["revision_id"]
    assert result["parent_propagation"] == "not_applicable"
    assert frozen() == before
    assert UpgradeApplication.objects.count() == 1


def test_nested_context_adopts_per_consumer_then_parent_propagates(users, project, pair):
    old, new = pair
    owner = users["owner"]
    module = create(
        owner,
        project,
        [occ("conn", old), occ("aux", old)],
        [link("inner", endpoint(["conn"], "pin-a"), endpoint(["aux"], "pin-a"))],
    )
    module_v1 = freeze(owner, module)
    root = create(
        owner,
        project,
        [occ("left", module_v1), occ("right", module_v1)],
        [link("outer", endpoint(["left", "conn"], "pin-a"), endpoint(["right", "conn"], "pin-a"))],
    )
    owning = freeze(owner, root)
    before = frozen()
    nested = {
        "owning_snapshot_id": owning["snapshot_id"],
        "old_revision_id": old["revision_id"],
        "candidate_revision_id": new["revision_id"],
        "relation": "declared_replacement",
        "replacement_basis": "Reviewer declares the replacement body in the module.",
        "context_path": ["left"],
        "paths": [["conn"]],
        "basis": "Reach the nested module use.",
    }
    with pytest.raises(ValidationFailed):
        op(owner, "upgrade.propose", {**nested, "context_path": ["missing"]})
    with pytest.raises(Unsupported):
        op(owner, "upgrade.propose", {**nested, "context_path": ["left", "conn"]})
    proposal = op(owner, "upgrade.propose", nested)
    assert proposal["consumer"]["revision_id"] == module_v1["revision_id"]
    assert proposal["relationship_decisions_required"] == ["inner"]
    propagation = proposal["parent_propagation"]
    assert propagation["status"] == "required"
    assert propagation["sibling_context_paths"] == [["right"]]
    assert propagation["outer_relationships"] == [{"context_path": [], "local_id": "outer"}]
    assert propagation["outer_assignments"] == []
    reviewed = review(
        owner,
        proposal,
        features=[mapping(["conn"], "pin-a", "c1")],
        relationships=[decision("inner", "retain")],
    )
    stale = {
        "proposal_id": proposal["proposal_id"],
        "mode": "existing_draft",
        "draft_id": module["draft_id"],
        "draft_expected_state": "draft-v9",
    }
    with pytest.raises(Conflict):
        op(owner, "upgrade.apply", stale, expected_state=reviewed["state"])
    root_draft = {
        **stale,
        "draft_id": root["draft_id"],
        "draft_expected_state": owning["draft"]["state"],
    }
    with pytest.raises(ValidationFailed):
        op(owner, "upgrade.apply", root_draft, expected_state=reviewed["state"])
    assert not UpgradeApplication.objects.exists()
    applied = op(
        owner,
        "upgrade.apply",
        {**stale, "draft_expected_state": module_v1["draft"]["state"]},
        expected_state=reviewed["state"],
    )
    assert applied["draft_id"] == module["draft_id"]
    assert applied["parent_propagation"] == "required"
    assert applied["content"]["assembly"]["relationships"][0]["a"]["feature_id"] == "c1"
    assert frozen() == before
    module_v2 = op(
        owner,
        "assembly.freeze",
        {"draft_id": module["draft_id"]},
        expected_state=applied["state"],
    )
    parent = {
        "owning_snapshot_id": owning["snapshot_id"],
        "old_revision_id": module_v1["revision_id"],
        "candidate_revision_id": module_v2["revision_id"],
        "paths": [["left"]],
        "basis": "Propagate the reviewed module revision to one use.",
    }
    proposal = op(owner, "upgrade.propose", parent)
    assert proposal["affected_features"] == [{"path": ["left", "conn"], "feature_id": "pin-a"}]
    assert proposal["relationship_decisions_required"] == ["outer"]
    with pytest.raises(ValidationFailed):
        review(owner, proposal, relationships=[decision("outer", "retain")])
    reviewed = review(
        owner,
        proposal,
        features=[mapping(["left", "conn"], "pin-a", "c1")],
        relationships=[decision("outer", "retain")],
    )
    result = op(
        owner,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=reviewed["state"],
    )
    outer = result["content"]["assembly"]["relationships"][0]
    assert outer["a"] == endpoint(["left", "conn"], "c1")
    assert outer["b"] == endpoint(["right", "conn"], "pin-a")
    assert [o["revision_id"] for o in result["content"]["assembly"]["occurrences"]] == [
        module_v2["revision_id"],
        module_v1["revision_id"],
    ]
    assert Snapshot.objects.get(id=owning["snapshot_id"]).canonical == before[owning["snapshot_id"]]


def test_replacement_assignment_decisions_are_explicit(users, project):
    owner = users["owner"]
    _, board = part(owner, project)
    _, other = part(owner, project, name="Synthetic alternate board")
    _, firmware = part(owner, project, "firmware")
    root = create(
        owner,
        project,
        [occ("ctrl", board, assignments={"firmware_revision_id": firmware["revision_id"]})],
    )
    owning = freeze(owner, root)
    proposal = op(
        owner,
        "upgrade.propose",
        {
            "owning_snapshot_id": owning["snapshot_id"],
            "old_revision_id": board["revision_id"],
            "candidate_revision_id": other["revision_id"],
            "relation": "declared_replacement",
            "replacement_basis": "Reviewer declares the alternate board use.",
            "paths": [["ctrl"]],
            "basis": "Replace the board identity.",
        },
    )
    assert proposal["assignment_decisions_required"] == [["ctrl"]]
    with pytest.raises(ValidationFailed):
        review(owner, proposal)
    reviewed = review(
        owner,
        proposal,
        assignments=[{"path": ["ctrl"], "decision": "remove", "basis": "Reassign later."}],
    )
    result = op(
        owner,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=reviewed["state"],
    )
    occurrence = result["content"]["assembly"]["occurrences"][0]
    assert occurrence["revision_id"] == other["revision_id"]
    assert occurrence["assignments"]["firmware_revision_id"] is None
    assert op(owner, "upgrade.read", {"proposal_id": proposal["proposal_id"]})["occurrences"][0][
        "candidate_assignments"
    ] == {"firmware_revision_id": None}


def test_consumers_list_workspace_nested_uses_and_project_references_first(users, project, pair):
    old, _ = pair
    owner, editor = users["owner"], users["editor"]
    module = freeze(owner, create(owner, project, [occ("conn", old)]))
    owning = freeze(owner, create(owner, project, [occ("left", module), occ("right", module)]))
    # A consumer that also pins content created from another project is a normal use.
    remote = op(owner, "project.create", {"name": "Library consumer source"})["project_id"]
    _, library = part(owner, remote)
    mixed = freeze(owner, create(owner, project, [occ("conn", old), occ("other", library)]))
    body = {"revision_id": old["revision_id"]}
    listed = op(editor, "upgrade.consumers", body)
    assert listed["workspace_id"] == workspace_of(project) and listed["project_id"] is None
    assert {c["owning_snapshot_id"] for c in listed["consumers"]} == {
        module["snapshot_id"],
        owning["snapshot_id"],
        mixed["snapshot_id"],
    }
    assert all("in_project" not in c for c in listed["consumers"])
    uses = next(c for c in listed["consumers"] if c["owning_snapshot_id"] == owning["snapshot_id"])
    assert uses["uses"] == [
        {"path": ["left", "conn"], "context_path": ["left"], "display_ref": "J1"},
        {"path": ["right", "conn"], "context_path": ["right"], "display_ref": "J1"},
    ]
    owning_definition = uses["owning_definition_id"]
    add(owner, remote, "definition", owning_definition, role="assembly")
    scoped = op(editor, "upgrade.consumers", {**body, "project_id": remote})
    assert scoped["consumers"][0]["owning_snapshot_id"] == owning["snapshot_id"]
    assert [c["in_project"] for c in scoped["consumers"]] == [True, False, False]
    query = f"/api/v0/revision-upgrades/consumers?revision_id={old['revision_id']}"
    assert api(editor).get(query).json() == listed
    assert api(users["outsider"]).get(query).status_code == 404
    with pytest.raises(NotFound):
        op(users["outsider"], "upgrade.consumers", body)
    with pytest.raises(NotFound):
        op(users["outsider"], "upgrade.consumers", {**body, "project_id": project})


def test_consumer_edit_authority_candidate_revocation_and_replay(users, project, pair):
    old, _ = pair
    owner, editor = users["owner"], users["editor"]
    remote = op(owner, "project.create", {"name": "Replacement source"})["project_id"]
    candidate = connector(owner, remote, "Remote replacement body", ["c1"])
    remote_module = freeze(owner, create(owner, remote, [occ("conn", old)]))
    owning = freeze(
        owner,
        create(owner, project, [occ("left", old), occ("sub", remote_module)]),
    )
    payload = {
        "owning_snapshot_id": owning["snapshot_id"],
        "old_revision_id": old["revision_id"],
        "candidate_revision_id": candidate["revision_id"],
        "relation": "declared_replacement",
        "replacement_basis": "Reviewer declares the remote replacement body.",
        "paths": [["left"]],
        "basis": "Replace a direct use.",
    }
    # Without design.edit no consumer (direct or nested) can receive an adoption draft.
    for actor in ("viewer", "contributor"):
        for body in (payload, {**payload, "context_path": ["sub"], "paths": [["conn"]]}):
            with pytest.raises(PermissionDenied):
                op(users[actor], "upgrade.propose", body)
    # The candidate stays hidden from a non-member before any edit diagnostic.
    with pytest.raises(NotFound):
        op(users["outsider"], "upgrade.propose", payload)
    # A consumer created from another project is an ordinary editable workspace item.
    nested = op(
        editor, "upgrade.propose", {**payload, "context_path": ["sub"], "paths": [["conn"]]}
    )
    assert nested["context_path"] == ["sub"]
    proposal = op(editor, "upgrade.propose", payload, idempotency_key="remote")
    reviewed = review(editor, proposal)
    remove_member(editor)
    for operation, body, context in [
        ("upgrade.read", {"proposal_id": proposal["proposal_id"]}, {}),
        (
            "upgrade.review",
            {"proposal_id": proposal["proposal_id"], "decision": "rejected", "basis": "x"},
            {"expected_state": "upgrade-v0"},
        ),
        (
            "upgrade.apply",
            {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
            {"expected_state": reviewed["state"]},
        ),
        ("upgrade.propose", {**payload, "paths": [["missing"]]}, {"idempotency_key": "remote"}),
    ]:
        with pytest.raises(NotFound):
            op(editor, operation, body, **context)
    assert not UpgradeApplication.objects.exists()
    member(editor, "viewer")
    with pytest.raises(PermissionDenied):
        op(editor, "upgrade.propose", payload, idempotency_key="remote")
    member(editor, "editor")
    assert op(editor, "upgrade.propose", payload, idempotency_key="remote") == proposal
    drafts = Draft.objects.count()
    applied = op(
        editor,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=reviewed["state"],
    )
    assert Draft.objects.count() == drafts + 1
    assert applied["content"]["assembly"]["occurrences"][0]["revision_id"] == str(
        candidate["revision_id"]
    )


def test_database_guards_identity_relation_and_consumer_link(users, flat, project):
    payload, owning = flat
    owner = users["owner"]
    snapshot = Snapshot.objects.get(id=owning["snapshot_id"])
    old = Revision.objects.get(id=payload["old_revision_id"])
    candidate = Revision.objects.get(id=payload["candidate_revision_id"])
    base = {
        "owning_snapshot": snapshot,
        "old_revision": old,
        "candidate_revision": candidate,
        "paths": [["left"]],
        "basis": "Direct row",
        "proposed_by": owner,
    }
    for invalid in [
        {"relation": "declared_replacement", "replacement_basis": ""},
        {"relation": "later_revision", "replacement_basis": ""},
        {"relation": "inferred", "replacement_basis": "x"},
        {
            "relation": "declared_replacement",
            "replacement_basis": "x",
            "context_path": ["left"],
        },
        {
            "relation": "declared_replacement",
            "replacement_basis": "x",
            "context_path": ["left"],
            "consumer_snapshot": old.snapshot,
        },
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            UpgradeProposal.objects.create(**base, **invalid)
    row = UpgradeProposal.objects.create(
        **base, relation="declared_replacement", replacement_basis="Declared"
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        UpgradeReview.objects.create(
            proposal=row,
            version=1,
            decision="accepted",
            basis="Wrong shape",
            relationship_decisions={},
            impacts={},
            evidence_status="unknown",
            reviewed_by=owner,
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        UpgradeProposal.objects.filter(id=row.id).update(relation="later_revision")


def test_removed_descendant_references_can_only_be_removed(users, project, pair):
    old, _ = pair
    owner = users["owner"]
    module = create(owner, project, [occ("conn", old)])
    module_v1 = freeze(owner, module)
    emptied = op(
        owner,
        "assembly.update",
        {"draft_id": module["draft_id"], "assembly": {"occurrences": []}},
        expected_state=module_v1["draft"]["state"],
    )
    module_v2 = freeze(owner, emptied)
    owning = freeze(
        owner,
        create(
            owner,
            project,
            [occ("left", module_v1), occ("right", module_v1)],
            [
                link(
                    "outer",
                    endpoint(["left", "conn"], "pin-a"),
                    endpoint(["right", "conn"], "pin-a"),
                )
            ],
        ),
    )
    proposal = op(
        owner,
        "upgrade.propose",
        {
            "owning_snapshot_id": owning["snapshot_id"],
            "old_revision_id": module_v1["revision_id"],
            "candidate_revision_id": module_v2["revision_id"],
            "paths": [["left"]],
            "basis": "Module no longer contains the body.",
        },
    )
    assert proposal["removed_paths"] == [["left", "conn"]]
    assert proposal["relationship_decisions_required"] == ["outer"]
    with pytest.raises(ValidationFailed):
        review(owner, proposal, relationships=[decision("outer", "retain")])
    reviewed = review(owner, proposal, relationships=[decision("outer", "remove")])
    assert reviewed["candidate_relationships"] == []
    result = op(
        owner,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=reviewed["state"],
    )
    assert result["content"]["assembly"]["relationships"] == []
