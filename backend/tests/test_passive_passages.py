"""TOP-002 exact source authority, immutable review and controlled model authoring."""

import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import DatabaseError, close_old_connections, connections, transaction

from specmate.access.models import WorkspaceMember
from specmate.design.models import Draft, Snapshot
from specmate.operations import (
    Conflict,
    Context,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    execute,
)
from specmate.passive_passages.models import PassageReview

from .conftest import ensure_member, op
from .test_catalog_matching import source_evidence
from .test_copper import board_population
from .test_interfaces import create as interface_create
from .test_interfaces import freeze as interface_freeze
from .test_pcb import attempt as pcb_attempt  # noqa: F401
from .test_pcb import intake, recipe, source  # noqa: F401
from .test_transports import api, post_op


@pytest.fixture
def circuit(users, project):
    owner = users["owner"]
    body = interface_create(
        owner,
        project,
        {"kind": "connector_body", "contacts": [{"contact_id": "a"}, {"contact_id": "b"}]},
    )
    root = interface_freeze(owner, body)
    graph = op(owner, "copper.graph", {"revision_id": root["revision_id"]})
    terminals = {n["terminal"]["contact_id"]: n["id"] for n in graph["nodes"]}
    model = {
        "root_revision_id": root["revision_id"],
        "assumptions": "ideal_lumped_components",
        "model_basis": "Reviewed original synthetic ideal resistor model; no measurement claim.",
        "passages": [
            {
                "local_id": "r1",
                "from_terminal_id": terminals["a"],
                "to_terminal_id": terminals["b"],
                "kind": "resistor",
                "resistance_ohm": "330",
                "basis": "Declared independent resistor parameter.",
            }
        ],
    }
    draft = op(
        owner,
        "passage.create",
        {"project_id": project, "name": "Synthetic passive model", "model": model},
    )
    frozen = op(
        owner, "passage.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    return root, terminals, model, draft, frozen


def review(user, frozen, state="passage-review-v0", idempotency_key=None, **changes):
    return op(
        user,
        "passage.review",
        {
            "revision_id": frozen["revision_id"],
            "decision": "accepted",
            "basis": "Reviewed only the declared ideal model.",
            **changes,
        },
        expected_state=state,
        idempotency_key=idempotency_key,
    )


def interpretation(user, frozen, terminals, query="dc_continuity", **changes):
    return op(
        user,
        "passage.interpret",
        {
            "revision_id": frozen["revision_id"],
            "from_terminal_id": terminals["a"],
            "to_terminal_id": terminals["b"],
            "query": query,
            "copper_assumption": "ideal_zero_resistance",
            **changes,
        },
    )


def test_exact_model_requires_review_and_freezes_complete_root_pin_without_rewriting(
    users, circuit
):
    root, terminals, model, draft, frozen = circuit
    owner = users["owner"]
    before = bytes(Snapshot.objects.get(id=root["snapshot_id"]).canonical)
    query = interpretation(owner, frozen, terminals)
    assert query["status"] == "unknown" and query["paths"] == []
    accepted = review(owner, frozen)
    result = interpretation(users["viewer"], frozen, terminals, "resistance")
    assert (
        result["status"] == "modeled_series_resistance" and result["series_resistance_ohm"] == "330"
    )
    assert result["review_id"] == accepted["reviews"][0]["review_id"]
    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    assert list(map(str, snapshot.dependencies.values_list("revision_id", flat=True))) == [
        root["revision_id"]
    ]
    assert bytes(Snapshot.objects.get(id=root["snapshot_id"]).canonical) == before
    changed = copy.deepcopy(model)
    changed["passages"][0]["resistance_ohm"] = "470"
    updated = op(
        owner,
        "passage.update",
        {"draft_id": draft["draft_id"], "model": changed},
        expected_state=frozen["draft"]["state"],
    )
    new = op(
        owner, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=updated["state"]
    )
    assert interpretation(owner, frozen, terminals, "resistance")["series_resistance_ohm"] == "330"
    assert interpretation(owner, new, terminals)["status"] == "unknown"
    assert snapshot.sha256 == frozen["sha256"]


def test_generic_authoring_obeys_typed_kind_capture_and_reference_guards(users, project, circuit):
    _root, _terminals, model, draft, frozen = circuit
    owner = users["owner"]
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "definition.create",
            {
                "project_id": project,
                "name": "Wrong typed kind",
                "kind": "part",
                "content": {"passages": model},
            },
        )
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "draft.update",
            {"draft_id": draft["draft_id"], "remove": ["passages"]},
            expected_state=frozen["draft"]["state"],
        )
    missing = copy.deepcopy(model)
    missing["passages"][0]["from_terminal_id"] = "terminal-" + "0" * 64
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "draft.update",
            {"draft_id": draft["draft_id"], "changes": {"passages": missing}},
            expected_state=frozen["draft"]["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "draft.freeze",
            {"draft_id": draft["draft_id"], "dependencies": [frozen["revision_id"]]},
            expected_state=frozen["draft"]["state"],
        )
    assert Draft.objects.get(id=draft["draft_id"]).state_token == frozen["draft"]["state"]


def test_scope_stale_state_review_replay_and_current_decision_are_shared(users, project, circuit):
    _root, terminals, model, draft, frozen = circuit
    owner = users["owner"]
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "passage.create",
            {"project_id": project, "name": "Denied", "model": model},
        )
    with pytest.raises(NotFound):
        op(users["outsider"], "passage.read", {"revision_id": frozen["revision_id"]})
    with pytest.raises(Conflict):
        op(
            owner,
            "passage.update",
            {"draft_id": draft["draft_id"], "model": model},
            expected_state="draft-v0",
        )
    accepted = review(owner, frozen, idempotency_key="review")
    assert review(owner, frozen, idempotency_key="review") == accepted
    with pytest.raises(IdempotencyMismatch):
        review(owner, frozen, decision="rejected", idempotency_key="review")
    with pytest.raises(Conflict):
        review(owner, frozen)
    rejected = review(owner, frozen, accepted["state"], decision="rejected")
    assert [r["decision"] for r in rejected["reviews"]] == ["accepted", "rejected"]
    assert (
        interpretation(owner, frozen, terminals)["reason"]
        == "current_accepted_model_review_required"
    )


def test_all_retained_review_sources_authorized_before_stale_conflict_read_or_replay(
    users, circuit
):
    _root, terminals, _model, _draft, frozen = circuit
    owner, editor = users["owner"], users["editor"]
    other = op(owner, "project.create", {"name": "Controlled passive review evidence"})[
        "project_id"
    ]
    ensure_member(editor, "viewer", project=other)
    evidence = source_evidence(users, other)
    initial = review(
        editor, frozen, decision="needs_evidence", evidence=evidence, idempotency_key="review"
    )
    review(editor, frozen, initial["state"])
    WorkspaceMember.objects.filter(workspace__projects=other, user=editor).delete()
    for action in [
        lambda: interpretation(editor, frozen, terminals),
        lambda: op(editor, "passage.read", {"revision_id": frozen["revision_id"]}),
        lambda: review(editor, frozen, state="passage-review-v0"),
        lambda: review(
            editor, frozen, state="passage-review-v0", decision="rejected", idempotency_key="review"
        ),
    ]:
        with pytest.raises(NotFound):
            action()
    assert (
        api(editor).get(f"/api/v0/passive-passages/revisions/{frozen['revision_id']}").status_code
        == 404
    )


def test_supplied_source_and_retained_create_closures_precede_terminal_or_key_diagnostics(
    users, project, circuit
):
    _root, _terminals, model, _draft, _frozen = circuit
    owner, editor = users["owner"], users["editor"]
    other = op(owner, "project.create", {"name": "Controlled assertion source"})["project_id"]
    ensure_member(editor, "viewer", project=other)
    assertion_source = source_evidence(users, other)
    sourced = copy.deepcopy(model)
    sourced["passages"][0]["evidence"] = assertion_source
    body = {"project_id": project, "name": "Source-backed assertion", "model": sourced}
    created = op(editor, "passage.create", body, idempotency_key="create")
    WorkspaceMember.objects.filter(workspace__projects=other, user=editor).delete()
    invalid = copy.deepcopy(sourced)
    invalid["passages"][0]["from_terminal_id"] = "terminal-" + "0" * 64
    with pytest.raises(NotFound):
        op(editor, "passage.create", {**body, "model": invalid}, idempotency_key="create")
    with pytest.raises(NotFound):
        op(editor, "passage.create", {**body, "model": model}, idempotency_key="create")
    with pytest.raises(NotFound):
        op(
            editor,
            "draft.update",
            {"draft_id": created["draft_id"], "changes": {"note": "Independent"}},
            expected_state="stale",
        )


def test_http_mcp_and_jobs_interpret_the_same_current_authority(users, circuit):
    _root, terminals, _model, _draft, frozen = circuit
    review(users["owner"], frozen)
    payload = {
        "revision_id": frozen["revision_id"],
        "from_terminal_id": terminals["a"],
        "to_terminal_id": terminals["b"],
        "query": "resistance",
        "copper_assumption": "ideal_zero_resistance",
    }
    expected = interpretation(users["viewer"], frozen, terminals, "resistance")
    assert post_op(api(users["viewer"]), "passage.interpret", payload).json()["result"] == expected
    assert (
        execute(
            "passage.interpret",
            Context(user=users["viewer"], via="mcp", request_id="passive-query"),
            payload,
        ).result
        == expected
    )
    assert post_op(api(users["outsider"]), "passage.interpret", payload).status_code == 404
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "passage.interpret", payload, idempotency_key="cached-query")


def test_database_guards_immutable_review_exact_kind_and_sequence(users, circuit):
    root, _terminals, _model, _draft, frozen = circuit
    owner = users["owner"]
    review(owner, frozen)
    for mutate in [
        lambda: PassageReview.objects.all().update(basis="Rewrite"),
        lambda: PassageReview.objects.all().delete(),
        lambda: PassageReview.objects.create(
            model_revision_id=frozen["revision_id"],
            version=3,
            decision="accepted",
            basis="Skip sequence",
            evidence_status="unknown",
            reviewed_by=owner,
        ),
        lambda: PassageReview.objects.create(
            model_revision_id=root["revision_id"],
            version=1,
            decision="accepted",
            basis="Wrong kind",
            evidence_status="unknown",
            reviewed_by=owner,
        ),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            mutate()


@pytest.mark.django_db(transaction=True)
def test_competing_model_reviews_serialize_and_fence_stale_expected_state(users, circuit):
    *_, frozen = circuit
    barrier = Barrier(2)

    def append():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            return review(users["owner"], frozen)["state"]
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        states = list(pool.map(lambda _: append(), range(2)))
    assert sorted(states) == ["conflict", "passage-review-v1"]
    assert PassageReview.objects.count() == 1


def test_native_resistor_candidates_remain_boundaries_until_separate_assertion_and_review(
    users, project, request
):
    owner = users["owner"]
    population, report = board_population(users, request.getfixturevalue("pcb_attempt"))
    root = op(
        owner,
        "pcb.population_freeze",
        {"draft_id": population["draft_id"]},
        expected_state=population["state"],
    )
    graph = op(owner, "copper.graph", {"revision_id": root["revision_id"]})
    candidate = next(b for b in graph["boundaries"] if b["kind"] == "resistor")
    nodes = {n["label"]: n["id"] for n in graph["nodes"]}
    model = {
        "root_revision_id": root["revision_id"],
        "assumptions": "ideal_lumped_components",
        "model_basis": "Separate ideal model; extracted labels and values remain candidates.",
        "passages": [],
    }
    draft = op(
        owner,
        "passage.create",
        {"project_id": project, "name": "Explicit native-root ideal model", "model": model},
    )
    frozen = op(
        owner, "passage.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    review(owner, frozen)
    terminals = {"a": nodes["J1.1"], "b": nodes["J2.1"]}
    empty = interpretation(owner, frozen, terminals)
    assert empty["status"] == "unknown" and empty["paths"] == []
    assert len(empty["unmodeled_boundaries"]) >= 1
    model["passages"] = [
        {
            "local_id": "declared-r1",
            "kind": "resistor",
            "from_terminal_id": nodes["R1.1"],
            "to_terminal_id": nodes["R1.2"],
            "resistance_ohm": "330",
            "basis": "Explicit ideal parameter, differing from the extraction candidate.",
            "native_candidate_boundary_id": candidate["id"],
        }
    ]
    changed = op(
        owner,
        "passage.update",
        {"draft_id": draft["draft_id"], "model": model},
        expected_state=frozen["draft"]["state"],
    )
    declared = op(
        owner, "passage.freeze", {"draft_id": draft["draft_id"]}, expected_state=changed["state"]
    )
    assert (
        interpretation(owner, declared, terminals)["reason"]
        == "current_accepted_model_review_required"
    )
    review(owner, declared)
    result = interpretation(owner, declared, terminals, "resistance")
    assert result["series_resistance_ohm"] == "330"
    assert [s["evidence"] for s in result["paths"][0]["steps"] if s["kind"] == "native_net"] == [
        "reported_net_membership",
        "reported_net_membership",
    ]
    assert op(owner, "copper.graph", {"revision_id": root["revision_id"]}) == graph
    assert report["component_passages"][0]["resistance_ohm"] == 100
    assert result["physical_continuity"] == "not_evaluated"


def test_root_project_revocation_precedes_query_selection_and_review_conflict(users, project):
    owner, editor = users["owner"], users["editor"]
    remote = op(owner, "project.create", {"name": "Restricted root graph"})["project_id"]
    ensure_member(editor, "viewer", project=remote)
    body = interface_create(
        owner,
        remote,
        {"kind": "connector_body", "contacts": [{"contact_id": "a"}, {"contact_id": "b"}]},
    )
    root = interface_freeze(owner, body)
    graph = op(editor, "copper.graph", {"revision_id": root["revision_id"]})
    terminals = {n["terminal"]["contact_id"]: n["id"] for n in graph["nodes"]}
    model = {
        "root_revision_id": root["revision_id"],
        "assumptions": "ideal_lumped_components",
        "model_basis": "Restricted exact root; explicit assumptions only",
        "passages": [],
    }
    draft = op(
        editor, "passage.create", {"project_id": project, "name": "Owned model", "model": model}
    )
    frozen = op(
        owner, "passage.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    review(editor, frozen)
    WorkspaceMember.objects.filter(workspace__projects=remote, user=editor).delete()
    with pytest.raises(NotFound):
        interpretation(editor, frozen, terminals, from_terminal_id="terminal-" + "0" * 64)
    with pytest.raises(NotFound):
        review(editor, frozen, state="stale")


def test_assertion_source_hash_rights_survive_frozen_view_and_interpreted_steps(
    users, project, circuit
):
    _root, terminals, model, draft, frozen = circuit
    owner = users["owner"]
    evidence = source_evidence(
        users, project, path="assertions/resistance.txt", rights=" synthetic declared rights "
    )
    model["passages"][0]["evidence"] = evidence
    updated = op(
        owner,
        "passage.update",
        {"draft_id": draft["draft_id"], "model": model},
        expected_state=frozen["draft"]["state"],
    )
    sourced = op(
        owner, "passage.freeze", {"draft_id": draft["draft_id"]}, expected_state=updated["state"]
    )
    view = review(owner, sourced)
    resolved = view["assertion_evidence"][0]["evidence"]
    assert resolved["source_path"] == "assertions/resistance.txt"
    assert resolved["sha256"] and resolved["rights"] == " synthetic declared rights "
    result = interpretation(owner, sourced, terminals)
    assert result["paths"][0]["steps"][0]["evidence"] == resolved


def test_condition_model_roundtrip_current_review_and_shared_query_assignments(users, circuit):
    _root, terminals, model, draft, frozen = circuit
    owner = users["owner"]
    model["conditions"] = [
        {
            "local_id": "option",
            "states": ["installed", "absent"],
            "basis": "Exclusive fitted option.",
        }
    ]
    model["passages"][0] = {
        "local_id": "option-contact",
        "from_terminal_id": terminals["a"],
        "to_terminal_id": terminals["b"],
        "kind": "conditional",
        "conditional_contact": {
            "condition_id": "option",
            "state": "installed",
            "behavior": "ideal_contact",
        },
        "basis": "Original synthetic ideal contact declaration.",
    }
    updated = op(
        owner,
        "passage.update",
        {"draft_id": draft["draft_id"], "model": model},
        expected_state=frozen["draft"]["state"],
    )
    saved = api(owner).get(f"/api/v0/drafts/{draft['draft_id']}").json()
    assert saved["content"]["passages"]["conditions"] == model["conditions"]
    conditional = op(
        owner, "passage.freeze", {"draft_id": draft["draft_id"]}, expected_state=updated["state"]
    )
    selected = [{"condition_id": "option", "state": "installed"}]
    assert (
        interpretation(owner, conditional, terminals, condition_assignments=selected)["status"]
        == "unknown"
    )
    inspected = review(owner, conditional)
    assert inspected["model"]["conditions"] == model["conditions"]
    payload = {
        "revision_id": conditional["revision_id"],
        "from_terminal_id": terminals["a"],
        "to_terminal_id": terminals["b"],
        "query": "dc_continuity",
        "copper_assumption": "ideal_zero_resistance",
        "condition_assignments": selected,
    }
    expected = interpretation(
        users["viewer"], conditional, terminals, condition_assignments=selected
    )
    assert expected["status"] == "modeled_dc_path"
    assert post_op(api(users["viewer"]), "passage.interpret", payload).json()["result"] == expected
    assert (
        execute(
            "passage.interpret",
            Context(user=users["viewer"], via="mcp", request_id="option-query"),
            payload,
        ).result
        == expected
    )
    assert interpretation(users["viewer"], conditional, terminals)["status"] == "unknown"
    assert (
        interpretation(
            users["viewer"],
            conditional,
            terminals,
            condition_assignments=[{"condition_id": "option", "state": "absent"}],
        )["status"]
        == "modeled_blocked"
    )
    # No query changes captured bytes or applies to an earlier independent model revision.
    assert (
        op(owner, "passage.read", {"revision_id": conditional["revision_id"]})["sha256"]
        == conditional["sha256"]
    )
    for invalid in [
        [{"condition_id": "option", "state": "missing"}],
        [{"condition_id": "missing", "state": "installed"}],
    ]:
        with pytest.raises(ValidationFailed):
            interpretation(users["viewer"], conditional, terminals, condition_assignments=invalid)
        with pytest.raises(NotFound):
            interpretation(users["outsider"], conditional, terminals, condition_assignments=invalid)
    with pytest.raises(ValidationFailed):
        interpretation(owner, frozen, terminals, condition_assignments=selected)
