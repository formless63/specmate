"""ACC-LIB-003: reviewed correspondence never collapses engineering identity."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import DatabaseError, close_old_connections, connection, transaction

from specmate.access.models import WorkspaceMember
from specmate.catalog_matching.models import MatchCandidate, MatchReview
from specmate.catalog_matching.queries import get_candidate, list_candidates, list_evidence_files
from specmate.design.models import Definition, Revision, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
)

from .conftest import ensure_member, op
from .test_design import freeze
from .test_sources import ORIGINAL, files, register
from .test_transports import api, post_op


@pytest.fixture
def pair(users, project, definition):
    source = freeze(users["owner"], definition["draft_id"], definition["state"])
    other = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "part",
            "name": "Candidate model",
        },
    )
    target = freeze(users["owner"], other["draft_id"], other["state"])
    return source, target


def proposal(pair, **changes):
    return {
        "source_revision_id": pair[0]["revision_id"],
        "target_revision_id": pair[1]["revision_id"],
        "association_kind": "supplier",
        "observed_source_identifier": "SYN-100",
        "observed_target_identifier": "SYN100",
        "basis": "Similar identifiers; engineering correspondence requires review.",
        **changes,
    }


def review(candidate, decision="accepted", **changes):
    return {
        "candidate_id": candidate["candidate_id"],
        "decision": decision,
        "basis": "Compared supplier drawing; no qualification claimed.",
        **changes,
    }


def source_evidence(users, project, *, path="src/source.txt", rights="synthetic-original"):
    register(users["owner"], project, ORIGINAL)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Correspondence evidence",
            "files": [{**files(ORIGINAL, path=path)[0], "rights": rights}],
        },
    )
    return {
        "status": "registered_file",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": path,
    }


@pytest.mark.parametrize("kind", ["import", "supplier", "model"])
def test_candidate_and_review_history_preserve_identities_and_snapshots(users, pair, kind):
    before = {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()}
    candidate = op(users["editor"], "catalog.propose_match", proposal(pair, association_kind=kind))
    assert candidate["decision"] == "unreviewed" and candidate["state"] == "match-v0"
    assert candidate["evidence"]["status"] == "unknown"
    assert candidate["source"]["definition_id"] != candidate["target"]["definition_id"]
    for decision in ("needs_evidence", "accepted", "rejected"):
        candidate = op(
            users["editor"],
            "catalog.review_match",
            review(candidate, decision),
            expected_state=candidate["state"],
        )
    assert candidate["meaning"] == "reviewed_correspondence_only"
    assert [r["decision"] for r in candidate["reviews"]] == [
        "needs_evidence",
        "accepted",
        "rejected",
    ]
    assert candidate["state"] == "match-v3"
    assert Definition.objects.count() == Revision.objects.count() == 2
    assert {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()} == before
    assert get_candidate(users["viewer"], candidate["candidate_id"]) == candidate


def test_exact_file_and_unverified_citation_preserve_provenance(users, project, pair):
    evidence = source_evidence(users, project, path="docs/drawing.txt ", rights=" declared rights ")
    candidate = op(users["editor"], "catalog.propose_match", proposal(pair, evidence=evidence))
    assert candidate["evidence"]["source_path"] == "docs/drawing.txt "
    assert candidate["evidence"]["rights"] == " declared rights "
    assert candidate["evidence"]["sha256"] is not None
    citation = {"status": "unverified_citation", "citation": " Supplier sheet, page 7 "}
    result = op(
        users["editor"],
        "catalog.review_match",
        review(candidate, evidence=citation),
        expected_state="match-v0",
    )
    assert result["reviews"][0]["evidence"]["citation"] == citation["citation"]
    assert result["reviews"][0]["evidence"]["sha256"] is None


def test_review_conflict_replay_mismatch_and_rollback(users, pair):
    payload = proposal(pair)
    candidate = op(users["editor"], "catalog.propose_match", payload, idempotency_key="proposal")
    assert (
        op(users["editor"], "catalog.propose_match", payload, idempotency_key="proposal")
        == candidate
    )
    result = op(
        users["editor"],
        "catalog.review_match",
        review(candidate),
        expected_state="match-v0",
        idempotency_key="review",
    )
    assert (
        op(
            users["editor"],
            "catalog.review_match",
            review(candidate),
            expected_state="match-v0",
            idempotency_key="review",
        )
        == result
    )
    with pytest.raises(Conflict) as error:
        op(users["editor"], "catalog.review_match", review(candidate), expected_state="match-v0")
    assert error.value.details["current"]["state"] == "match-v1"
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "catalog.review_match",
            review(candidate, "rejected"),
            expected_state="match-v0",
            idempotency_key="review",
        )
    with pytest.raises(ValidationFailed):
        op(users["editor"], "catalog.review_match", review(candidate))
    assert MatchCandidate.objects.count() == MatchReview.objects.count() == 1


def test_same_definition_requires_new_revision_adoption_not_matching(users, pair):
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "catalog.propose_match",
            proposal(pair, target_revision_id=pair[0]["revision_id"]),
        )
    assert not MatchCandidate.objects.exists()


def test_current_actor_scope_and_source_edit_authority(users, project, pair):
    for name, error in [("viewer", PermissionDenied), ("outsider", NotFound)]:
        with pytest.raises(error):
            op(users[name], "catalog.propose_match", proposal(pair))
    candidate = op(
        users["editor"], "catalog.propose_match", proposal(pair), idempotency_key="match"
    )
    WorkspaceMember.objects.filter(user=users["editor"], workspace__projects=project).update(
        role="viewer"
    )
    with pytest.raises(PermissionDenied):
        op(users["editor"], "catalog.propose_match", proposal(pair), idempotency_key="match")
    users["viewer"].is_active = False
    users["viewer"].save(update_fields=["is_active"])
    with pytest.raises(Unauthenticated):
        get_candidate(users["viewer"], candidate["candidate_id"])


def test_all_historical_evidence_reauthorized_before_conflict_read_or_replay(users, pair):
    other = op(users["owner"], "project.create", {"name": "Evidence library"})["project_id"]
    ensure_member(users["editor"], "viewer", project=other)
    evidence = source_evidence(users, other)
    candidate = op(
        users["editor"], "catalog.propose_match", proposal(pair), idempotency_key="match"
    )
    first = op(
        users["editor"],
        "catalog.review_match",
        review(candidate, evidence=evidence),
        expected_state="match-v0",
        idempotency_key="first",
    )
    op(
        users["editor"],
        "catalog.review_match",
        review(first, "needs_evidence"),
        expected_state="match-v1",
    )
    WorkspaceMember.objects.filter(workspace__projects=other, user=users["editor"]).delete()
    for invoke in (
        lambda: get_candidate(users["editor"], candidate["candidate_id"]),
        lambda: op(
            users["editor"], "catalog.review_match", review(candidate), expected_state="match-v0"
        ),
        lambda: op(
            users["editor"],
            "catalog.review_match",
            review(candidate, evidence=evidence),
            expected_state="match-v0",
            idempotency_key="first",
        ),
        lambda: op(
            users["editor"], "catalog.propose_match", proposal(pair), idempotency_key="match"
        ),
        lambda: op(
            users["editor"],
            "catalog.propose_match",
            proposal(pair, basis="Changed request"),
            idempotency_key="match",
        ),
    ):
        with pytest.raises(NotFound) as error:
            invoke()
        assert error.value.details == {}
    assert list_candidates(users["editor"], pair[0]["revision_id"])["results"] == []
    assert MatchReview.objects.count() == 2


@pytest.mark.parametrize(
    "evidence",
    [
        {"status": "registered_file"},
        {"status": "unknown", "citation": "Claimed sheet"},
        {"status": "unverified_citation"},
        {"status": "unverified_citation", "citation": " "},
    ],
)
def test_invalid_evidence_rolls_back(users, pair, evidence):
    with pytest.raises(ValidationFailed):
        op(users["editor"], "catalog.propose_match", proposal(pair, evidence=evidence))
    assert not MatchCandidate.objects.exists()


def test_target_requires_read_not_edit_authority(users, pair):
    other = op(users["owner"], "project.create", {"name": "Read only target"})["project_id"]
    ensure_member(users["editor"], "viewer", project=other)
    draft = op(
        users["owner"],
        "definition.create",
        {
            "project_id": other,
            "kind": "part",
            "name": "Shared target",
        },
    )
    target = freeze(users["owner"], draft["draft_id"], draft["state"])
    candidate = op(users["editor"], "catalog.propose_match", proposal((pair[0], target)))
    assert (
        op(users["editor"], "catalog.review_match", review(candidate), expected_state="match-v0")[
            "decision"
        ]
        == "accepted"
    )
    WorkspaceMember.objects.filter(workspace__projects=other, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        get_candidate(users["editor"], candidate["candidate_id"])


def test_target_retained_dependency_closure_reauthorized(users, project, pair):
    other = op(users["owner"], "project.create", {"name": "Target library"})["project_id"]
    ensure_member(users["editor"], "viewer", project=other)
    draft = op(
        users["owner"],
        "definition.create",
        {
            "project_id": other,
            "kind": "part",
            "name": "Hidden dependency",
        },
    )
    dependency = freeze(users["owner"], draft["draft_id"], draft["state"])
    target_draft = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "part",
            "name": "Target with closure",
        },
    )
    target = freeze(
        users["owner"], target_draft["draft_id"], target_draft["state"], [dependency["revision_id"]]
    )
    payload = proposal((pair[0], target))
    candidate = op(users["editor"], "catalog.propose_match", payload, idempotency_key="closure")
    WorkspaceMember.objects.filter(workspace__projects=other, user=users["editor"]).delete()
    for invoke in (
        lambda: get_candidate(users["editor"], candidate["candidate_id"]),
        lambda: op(users["editor"], "catalog.propose_match", payload, idempotency_key="closure"),
        lambda: op(
            users["editor"], "catalog.review_match", review(candidate), expected_state="match-v0"
        ),
    ):
        with pytest.raises(NotFound):
            invoke()


def test_api_command_reads_and_visible_pagination(users, pair):
    client = api(users["editor"])
    created = [
        post_op(client, "catalog.propose_match", proposal(pair)).json()["result"] for _ in range(3)
    ]
    url = f"/api/v0/catalog-matching/revisions/{pair[0]['revision_id']}"
    page = client.get(url + "?limit=2").json()
    assert len(page["results"]) == 2 and page["next_after"]
    next_page = client.get(url + "?limit=2&after=" + page["next_after"]).json()
    assert len(next_page["results"]) == 1 and next_page["next_after"] is None
    assert {r["candidate_id"] for r in page["results"] + next_page["results"]} == {
        r["candidate_id"] for r in created
    }
    assert client.get(url + "?limit=101").status_code == 422
    assert api(users["outsider"]).get(url).status_code == 404
    assert api().get(url).status_code == 401
    detail = f"/api/v0/catalog-matching/candidates/{created[0]['candidate_id']}"
    assert api(users["viewer"]).get(detail).json() == created[0]
    assert (
        post_op(
            api(users["viewer"]),
            "catalog.review_match",
            review(created[0]),
            expected_state="match-v0",
        ).status_code
        == 403
    )
    assert (
        post_op(
            client, "catalog.review_match", review(created[0]), expected_state="match-v0"
        ).status_code
        == 200
    )


def test_candidate_cursor_belongs_to_source_and_rechecks_retained_authority(users, project, pair):
    visible = op(users["editor"], "catalog.propose_match", proposal(pair))
    other = op(users["owner"], "project.create", {"name": "Cursor evidence scope"})["project_id"]
    ensure_member(users["editor"], "viewer", project=other)
    evidence = source_evidence(users, other)
    hidden = op(users["editor"], "catalog.propose_match", proposal(pair, evidence=evidence))
    reversed_match = op(users["editor"], "catalog.propose_match", proposal((pair[1], pair[0])))
    with pytest.raises(NotFound):
        list_candidates(
            users["editor"], pair[0]["revision_id"], after=reversed_match["candidate_id"]
        )
    WorkspaceMember.objects.filter(workspace__projects=other, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        list_candidates(users["editor"], pair[0]["revision_id"], after=hidden["candidate_id"])
    page = list_candidates(users["editor"], pair[0]["revision_id"], limit=1)
    assert page["results"] == [visible] and page["next_after"] is None
    assert (
        list_candidates(users["editor"], pair[0]["revision_id"], after=visible["candidate_id"])[
            "results"
        ]
        == []
    )


def test_evidence_file_cursor_scope_access_and_visible_pages(users, project):
    source_evidence(users, project)
    page = list_evidence_files(users["editor"], project, limit=1)
    assert len(page["results"]) == 1 and page["next_after"] is None
    cursor = page["results"][0]["file_id"]
    assert list_evidence_files(users["editor"], project, after=cursor)["results"] == []
    other = op(users["owner"], "project.create", {"name": "Separate evidence"})["project_id"]
    ensure_member(users["editor"], "viewer", project=other)
    source_evidence(users, other)
    other_cursor = list_evidence_files(users["editor"], other)["results"][0]["file_id"]
    with pytest.raises(NotFound):
        list_evidence_files(users["editor"], project, after=other_cursor)
    with pytest.raises(NotFound):
        list_evidence_files(users["editor"], project, after=9999999)
    with pytest.raises(NotFound):
        list_evidence_files(users["editor"], project, after=0)
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        list_evidence_files(users["editor"], project, after=cursor)


@pytest.mark.parametrize(
    "table", ["catalog_matching_matchcandidate", "catalog_matching_matchreview"]
)
def test_database_immutability_and_sequential_review_guards(users, pair, table):
    candidate = op(users["editor"], "catalog.propose_match", proposal(pair))
    op(users["editor"], "catalog.review_match", review(candidate), expected_state="match-v0")
    for sql in (f"UPDATE {table} SET id=id", f"DELETE FROM {table}"):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql)
    with pytest.raises(DatabaseError), transaction.atomic():
        MatchReview.objects.create(
            candidate_id=candidate["candidate_id"],
            version=3,
            decision="accepted",
            basis="Gap rejected",
            evidence_status="unknown",
            reviewed_by=users["owner"],
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        MatchCandidate.objects.create(
            source_revision_id=pair[0]["revision_id"],
            target_revision_id=pair[0]["revision_id"],
            association_kind="model",
            observed_source_identifier="X",
            observed_target_identifier="X",
            basis="Same definition",
            evidence_status="unknown",
            proposed_by=users["owner"],
        )


@pytest.mark.django_db(transaction=True)
def test_concurrent_review_uses_compare_and_set(users, pair):
    candidate = op(users["editor"], "catalog.propose_match", proposal(pair))
    barrier = Barrier(2)

    def competing(decision):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                op(
                    users["editor"],
                    "catalog.review_match",
                    review(candidate, decision),
                    expected_state="match-v0",
                )
                return "created"
            except Conflict:
                return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(competing, ["accepted", "rejected"])) == ["conflict", "created"]
    assert MatchReview.objects.count() == 1
