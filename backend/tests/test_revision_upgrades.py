"""FND-008 / CFG-004: reviewed selected adoption preserves historic pins."""

import pytest
from django.db import DatabaseError, transaction

from specmate.access.models import Membership
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

from .conftest import op
from .test_assemblies import create, endpoint, freeze, occ, part
from .test_catalog_matching import source_evidence
from .test_transports import api, post_op


@pytest.fixture
def fixture(users, project):
    owner = users["owner"]
    body = op(
        owner,
        "interface.create",
        {
            "project_id": project,
            "name": "Synthetic connector",
            "interface": {"kind": "connector_body", "contacts": [{"contact_id": "pin-a"}]},
        },
    )
    old = op(
        owner, "interface.freeze", {"draft_id": body["draft_id"]}, expected_state=body["state"]
    )
    update = op(
        owner,
        "interface.update",
        {
            "draft_id": body["draft_id"],
            "interface": {"kind": "connector_body", "contacts": [{"contact_id": "pin-b"}]},
        },
        expected_state=old["draft"]["state"],
    )
    candidate = op(
        owner, "interface.freeze", {"draft_id": body["draft_id"]}, expected_state=update["state"]
    )
    root = create(
        owner,
        project,
        [occ("left", old), occ("right", old)],
        [
            {
                "kind": "electrical",
                "local_id": "link",
                "a": endpoint(["left"], "pin-a"),
                "b": endpoint(["right"], "pin-a"),
            }
        ],
    )
    owning = freeze(owner, root)
    payload = {
        "owning_snapshot_id": owning["snapshot_id"],
        "old_revision_id": old["revision_id"],
        "candidate_revision_id": candidate["revision_id"],
        "paths": [["left"]],
        "basis": "Inspect changed contact declaration.",
    }
    return payload, owning


def accepted(user, proposal, **extra):
    return op(
        user,
        "upgrade.review",
        {
            "proposal_id": proposal["proposal_id"],
            "decision": "accepted",
            "basis": "Declared contact correspondence only.",
            "features": [
                {
                    "path": ["left"],
                    "old_feature_id": "pin-a",
                    "candidate_feature_id": "pin-b",
                    "basis": "Reviewed synthetic contact change.",
                }
            ],
            **extra,
        },
        expected_state=proposal["state"],
    )


def test_independent_selected_adoption_retains_relationships_unknowns_and_frozen_state(
    users, fixture
):
    payload, owning = fixture
    owner = users["owner"]
    before = {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()}
    proposal = op(owner, "upgrade.propose", payload, idempotency_key="proposal")
    assert proposal["state"] == "upgrade-v0"
    assert all(i["status"] == "not_evaluated" for i in proposal["impacts"].values())
    assert proposal["affected_features"] == [{"path": ["left"], "feature_id": "pin-a"}]
    assert op(owner, "upgrade.propose", payload, idempotency_key="proposal") == proposal
    reviewed = accepted(owner, proposal)
    assert reviewed["candidate_relationships"][0]["a"]["feature_id"] == "pin-b"
    result = op(
        owner,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=reviewed["state"],
        idempotency_key="adopt",
    )
    assert result["draft_id"] != owning["draft"]["draft_id"]
    assert result["base_revision_id"] == owning["revision_id"]
    assembly = result["content"]["assembly"]
    assert [o["revision_id"] for o in assembly["occurrences"]] == [
        payload["candidate_revision_id"],
        payload["old_revision_id"],
    ]
    assert assembly["relationships"][0]["a"]["feature_id"] == "pin-b"
    assert assembly["relationships"][0]["b"]["feature_id"] == "pin-a"
    assert all(o["placement"]["status"] == "unknown" for o in assembly["occurrences"])
    assert {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()} == before
    assert (
        op(
            owner,
            "upgrade.apply",
            {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
            expected_state=reviewed["state"],
            idempotency_key="adopt",
        )
        == result
    )
    assert UpgradeApplication.objects.count() == 1
    captured = freeze(owner, result)
    pins = set(
        map(
            str,
            Snapshot.objects.get(id=captured["snapshot_id"]).dependencies.values_list(
                "revision_id", flat=True
            ),
        )
    )
    assert pins == {payload["candidate_revision_id"], payload["old_revision_id"]}


def test_feature_correspondence_required_even_equal_labels_and_no_partial_review(users, fixture):
    payload, _ = fixture
    proposal = op(users["owner"], "upgrade.propose", payload)
    for features in (
        [],
        [
            {
                "path": ["left"],
                "old_feature_id": "pin-a",
                "candidate_feature_id": "pin-a",
                "basis": "Same label is not evidence.",
            }
        ],
    ):
        with pytest.raises(ValidationFailed):
            op(
                users["owner"],
                "upgrade.review",
                {
                    "proposal_id": proposal["proposal_id"],
                    "decision": "accepted",
                    "basis": "Inspect",
                    "features": features,
                },
                expected_state=proposal["state"],
            )
    assert not UpgradeReview.objects.exists()
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "upgrade.apply",
            {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
            expected_state="upgrade-v0",
        )


def test_existing_target_has_independent_cas_and_exact_baseline(users, fixture):
    payload, owning = fixture
    owner = users["owner"]
    proposal = accepted(owner, op(owner, "upgrade.propose", payload))
    adoption = {
        "proposal_id": proposal["proposal_id"],
        "mode": "existing_draft",
        "draft_id": owning["draft"]["draft_id"],
        "draft_expected_state": "draft-v1",
    }
    with pytest.raises(Conflict):
        op(owner, "upgrade.apply", adoption, expected_state=proposal["state"])
    adoption["draft_expected_state"] = owning["draft"]["state"]
    updated = op(
        owner,
        "draft.update",
        {"draft_id": adoption["draft_id"], "changes": {"note": "Independent edit"}},
        expected_state=adoption["draft_expected_state"],
    )
    adoption["draft_expected_state"] = updated["state"]
    with pytest.raises(ValidationFailed):
        op(owner, "upgrade.apply", adoption, expected_state=proposal["state"])
    restored = op(
        owner,
        "draft.update",
        {"draft_id": adoption["draft_id"], "remove": ["note"]},
        expected_state=updated["state"],
    )
    adoption["draft_expected_state"] = restored["state"]
    result = op(owner, "upgrade.apply", adoption, expected_state=proposal["state"])
    assert result["draft_id"] == adoption["draft_id"]
    assert result["state"] != restored["state"]


def test_review_history_current_decision_stale_cas_and_key_mismatch(users, fixture):
    payload, _ = fixture
    owner = users["owner"]
    proposal = op(owner, "upgrade.propose", payload, idempotency_key="proposal")
    reviewed = accepted(owner, proposal)
    with pytest.raises(Conflict):
        accepted(owner, proposal)
    rejected = op(
        owner,
        "upgrade.review",
        {
            "proposal_id": proposal["proposal_id"],
            "decision": "rejected",
            "basis": "Additional evidence required",
        },
        expected_state=reviewed["state"],
    )
    assert [r["decision"] for r in rejected["reviews"]] == ["accepted", "rejected"]
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "upgrade.apply",
            {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
            expected_state=rejected["state"],
        )
    with pytest.raises(IdempotencyMismatch):
        op(owner, "upgrade.propose", {**payload, "paths": [["right"]]}, idempotency_key="proposal")


def test_scope_sources_retained_evidence_and_denial_before_replay_or_conflict(
    users, project, fixture
):
    payload, _ = fixture
    owner, editor = users["owner"], users["editor"]
    remote = op(owner, "project.create", {"name": "Review evidence scope"})["project_id"]
    Membership.objects.create(project_id=remote, user=editor, role="viewer")
    evidence = source_evidence(users, remote)
    proposal = op(editor, "upgrade.propose", payload, idempotency_key="proposal")
    reviewed = accepted(editor, proposal, evidence=evidence)
    Membership.objects.filter(project_id=remote, user=editor).delete()
    for operation, body, context in [
        ("upgrade.read", {"proposal_id": proposal["proposal_id"]}, {}),
        (
            "upgrade.review",
            {"proposal_id": proposal["proposal_id"], "decision": "rejected", "basis": "Inspect"},
            {"expected_state": "upgrade-v0"},
        ),
        (
            "upgrade.apply",
            {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
            {"expected_state": "upgrade-v0"},
        ),
        ("upgrade.propose", {**payload, "paths": [["right"]]}, {"idempotency_key": "proposal"}),
    ]:
        with pytest.raises(NotFound):
            op(editor, operation, body, **context)
    assert reviewed["reviews"][0]["evidence"]["sha256"]
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "upgrade.propose", payload)
    with pytest.raises(NotFound):
        op(users["outsider"], "upgrade.propose", payload)


def test_preserves_repeated_nested_firmware_assignments_and_rejects_changed_descendants(
    users, project
):
    owner = users["owner"]
    _, board = part(owner, project)
    _, firmware = part(owner, project, "firmware")
    module = create(owner, project, [occ("board", board)])
    old = freeze(owner, module)
    new = op(
        owner,
        "draft.freeze",
        {"draft_id": module["draft_id"]},
        expected_state=old["draft"]["state"],
    )
    root = create(
        owner,
        project,
        [occ("left", old), occ("right", old)],
        assignments=[
            {
                "path": ["left", "board"],
                "assignments": {"firmware_revision_id": firmware["revision_id"]},
            }
        ],
    )
    owning = freeze(owner, root)
    payload = {
        "owning_snapshot_id": owning["snapshot_id"],
        "old_revision_id": old["revision_id"],
        "candidate_revision_id": new["revision_id"],
        "paths": [["left"]],
        "basis": "Retain nested board identity",
    }
    proposal = op(owner, "upgrade.propose", payload)
    reviewed = op(
        owner,
        "upgrade.review",
        {
            "proposal_id": proposal["proposal_id"],
            "decision": "accepted",
            "basis": "Nested pins unchanged",
        },
        expected_state=proposal["state"],
    )
    result = op(
        owner,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=reviewed["state"],
    )
    assert (
        result["content"]["assembly"]["assignments"][0]["assignments"]["firmware_revision_id"]
        == firmware["revision_id"]
    )
    _, replacement = part(owner, project)
    changed = op(
        owner,
        "assembly.update",
        {"draft_id": module["draft_id"], "assembly": {"occurrences": [occ("board", replacement)]}},
        expected_state=new["draft"]["state"],
    )
    latest = freeze(owner, changed)
    with pytest.raises(Unsupported):
        op(owner, "upgrade.propose", {**payload, "candidate_revision_id": latest["revision_id"]})
    with pytest.raises(Unsupported):
        op(owner, "upgrade.propose", {**payload, "paths": [["left", "board"]]})


def test_api_uses_same_mutations_reads_and_denials(users, fixture):
    payload, _ = fixture
    response = post_op(api(users["editor"]), "upgrade.propose", payload)
    assert response.status_code == 200
    proposal = response.json()["result"]
    url = f"/api/v0/revision-upgrades/proposals/{proposal['proposal_id']}"
    assert api(users["viewer"]).get(url).json() == proposal
    assert api(users["outsider"]).get(url).status_code == 404
    assert post_op(api(users["viewer"]), "upgrade.propose", payload).status_code == 403


def test_database_guards_proposals_reviews_and_application_history(users, fixture):
    payload, _ = fixture
    owner = users["owner"]
    proposal = accepted(owner, op(owner, "upgrade.propose", payload))
    result = op(
        owner,
        "upgrade.apply",
        {"proposal_id": proposal["proposal_id"], "mode": "new_draft"},
        expected_state=proposal["state"],
    )
    for model, mutation in [
        (UpgradeProposal, {"basis": "rewrite"}),
        (UpgradeReview, {"basis": "rewrite"}),
        (UpgradeApplication, {"draft_version": 9}),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            model.objects.all().update(**mutation)
    row = UpgradeProposal.objects.get(id=proposal["proposal_id"])
    with pytest.raises(DatabaseError), transaction.atomic():
        UpgradeReview.objects.create(
            proposal=row,
            version=3,
            decision="accepted",
            basis="Skip review sequence",
            features=[],
            impacts={},
            evidence_status="unknown",
            reviewed_by=owner,
        )
    review = UpgradeReview.objects.get(proposal=row)
    other_draft = op(
        owner,
        "definition.create",
        {
            "project_id": str(row.owning_snapshot.definition.project_id),
            "kind": "part",
            "name": "Wrong owner",
        },
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        UpgradeApplication.objects.create(
            proposal=row,
            review=review,
            draft_id=other_draft["draft_id"],
            draft_version=1,
            applied_by=owner,
        )
    assert Draft.objects.get(id=result["draft_id"]).version == 1


def test_unchanged_contact_labels_still_require_explicit_review(users, fixture):
    payload, _ = fixture
    owner = users["owner"]
    old = op(owner, "upgrade.propose", payload)["old"]
    revision = Revision.objects.get(id=old["revision_id"])
    same = op(
        owner,
        "interface.update",
        {
            "draft_id": str(revision.snapshot.draft_id),
            "interface": {"kind": "connector_body", "contacts": [{"contact_id": "pin-a"}]},
        },
        expected_state="draft-v4",
    )
    candidate = op(
        owner, "interface.freeze", {"draft_id": same["draft_id"]}, expected_state=same["state"]
    )
    proposal = op(
        owner, "upgrade.propose", {**payload, "candidate_revision_id": candidate["revision_id"]}
    )
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "upgrade.review",
            {
                "proposal_id": proposal["proposal_id"],
                "decision": "accepted",
                "basis": "Labels unchanged",
            },
            expected_state=proposal["state"],
        )
    reviewed = accepted(
        owner,
        proposal,
        features=[
            {
                "path": ["left"],
                "old_feature_id": "pin-a",
                "candidate_feature_id": "pin-a",
                "basis": "Compared the exact unchanged contact",
            }
        ],
    )
    assert reviewed["decision"] == "accepted"
    assert reviewed["candidate_relationships"][0]["a"]["feature_id"] == "pin-a"
    assert reviewed["qualification"] == "not_evaluated"


def test_apply_retained_outcome_authorizes_edited_draft_before_mismatch(users, fixture):
    payload, _ = fixture
    owner, editor = users["owner"], users["editor"]
    proposal = accepted(editor, op(editor, "upgrade.propose", payload))
    adoption = {"proposal_id": proposal["proposal_id"], "mode": "new_draft"}
    result = op(
        editor,
        "upgrade.apply",
        adoption,
        expected_state=proposal["state"],
        idempotency_key="retained-adoption",
    )
    remote = op(owner, "project.create", {"name": "Restricted later draft source"})["project_id"]
    _, secret = part(owner, remote)
    draft = Draft.objects.get(id=result["draft_id"])
    body = draft.content["assembly"]
    body["occurrences"].append(occ("private-later-child", secret))
    op(
        owner,
        "assembly.update",
        {"draft_id": result["draft_id"], "assembly": body},
        expected_state=result["state"],
    )
    for supplied in [
        adoption,
        {
            **adoption,
            "mode": "existing_draft",
            "draft_id": result["draft_id"],
            "draft_expected_state": "draft-v2",
        },
    ]:
        with pytest.raises(NotFound):
            op(
                editor,
                "upgrade.apply",
                supplied,
                expected_state=proposal["state"],
                idempotency_key="retained-adoption",
            )


@pytest.mark.django_db(transaction=True)
def test_competing_reviews_serialize_under_exact_proposal_token(users, fixture):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connections

    payload, _ = fixture
    owner = users["owner"]
    proposal = op(owner, "upgrade.propose", payload)
    barrier = Barrier(2)

    def append_review():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            return accepted(owner, proposal)["state"]
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: append_review(), range(2)))
    assert sorted(outcomes) == ["conflict", "upgrade-v1"]
    assert UpgradeReview.objects.count() == 1


def test_owning_pack_origin_source_revocation_precedes_paths_and_key_mismatch(
    users, project, fixture
):
    from specmate.catalog_packs.models import AdoptionEntry
    from specmate.sources.models import SourceBundleFile

    from .test_catalog_packs import manifest

    payload, owning = fixture
    owner, editor = users["owner"], users["editor"]
    source_project = op(owner, "project.create", {"name": "Controlled owning origin source"})[
        "project_id"
    ]
    Membership.objects.create(project_id=source_project, user=editor, role="viewer")
    evidence = source_evidence(users, source_project)
    source = SourceBundleFile.objects.select_related("blob").get(
        revision_id=evidence["source_bundle_revision_id"], path=evidence["source_path"]
    )
    declaration = manifest(owning)
    declaration["entries"][0]["source"] = {
        "source_bundle_revision_id": evidence["source_bundle_revision_id"],
        "source_path": evidence["source_path"],
        "sha256": source.blob.sha256,
        "rights": source.rights,
    }
    version = op(editor, "catalog_pack.register", {"project_id": project, "manifest": declaration})
    op(
        editor,
        "catalog_pack.install",
        {
            "pack_id": version["pack_id"],
            "version_id": version["version_id"],
            "basis": "Reviewed inert origin",
        },
        expected_state="pack-v0",
    )
    op(
        editor,
        "catalog_pack.adopt",
        {
            "pack_id": version["pack_id"],
            "version_id": version["version_id"],
            "entry_keys": ["part"],
            "basis": "Independent owning assembly",
        },
        expected_state="pack-v1",
    )
    adopted = AdoptionEntry.objects.get()
    capture = op(
        owner, "assembly.freeze", {"draft_id": str(adopted.draft_id)}, expected_state="draft-v1"
    )
    supplied = {**payload, "owning_snapshot_id": capture["snapshot_id"]}
    proposal = op(editor, "upgrade.propose", supplied, idempotency_key="origin-proposal")
    inspected = op(editor, "upgrade.inspect_owner", {"snapshot_id": capture["snapshot_id"]})
    assert len(inspected["occurrences"]) == 2
    Membership.objects.filter(project_id=source_project, user=editor).delete()
    with pytest.raises(NotFound):
        op(editor, "upgrade.inspect_owner", {"snapshot_id": capture["snapshot_id"]})
    assert (
        api(editor).get(f"/api/v0/revision-upgrades/snapshots/{capture['snapshot_id']}").status_code
        == 404
    )
    for changed in [
        supplied,
        {**supplied, "paths": [["missing"]]},
        {**supplied, "candidate_revision_id": supplied["old_revision_id"]},
    ]:
        with pytest.raises(NotFound):
            op(editor, "upgrade.propose", changed, idempotency_key="origin-proposal")
    with pytest.raises(NotFound):
        op(editor, "upgrade.read", {"proposal_id": proposal["proposal_id"]})


def test_mcp_operation_context_uses_same_review_authority(users, fixture):
    from specmate.operations import Context, execute

    payload, _ = fixture
    result = execute(
        "upgrade.propose",
        Context(user=users["editor"], via="mcp", request_id="mcp-proposal"),
        payload,
    ).result
    read = execute(
        "upgrade.read",
        Context(user=users["viewer"], via="mcp", request_id="mcp-read"),
        {"proposal_id": result["proposal_id"]},
    ).result
    assert read == result
    with pytest.raises(PermissionDenied):
        execute(
            "upgrade.propose",
            Context(user=users["viewer"], via="mcp", request_id="mcp-denied"),
            payload,
        )
