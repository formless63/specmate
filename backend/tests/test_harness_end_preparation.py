"""Explicit physical identity, authority and frozen per-section preparation intent."""

import copy
from types import SimpleNamespace

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from specmate.access.models import Membership
from specmate.design.models import Snapshot
from specmate.end_preparation import api
from specmate.end_preparation.contracts import ApplyHarnessProfile
from specmate.harnesses.queries import inspect_revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    Unauthenticated,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord

from .conftest import op
from .test_end_preparation import create as create_profile
from .test_end_preparation import freeze, profile
from .test_harnesses import capture, create, fixture


def declarations():
    # Both displayed segment ends are b; that letter is not physical handedness.
    return [
        {
            "local_id": name,
            "label": "same label",
            "segment_ends": [{"segment_id": segment, "end": "b"}],
            "endpoint_id": endpoint,
            "basis": "Explicit synthetic material end",
            "review": "reviewed",
        }
        for name, segment, endpoint in [
            ("cut-one", "trunk", "input"),
            ("cut-two", "leg-one", "output"),
        ]
    ]


def setup(users, project, ends=None):
    owner = users["owner"]
    stock, body, _, harness = fixture(owner, project)
    harness["sections"][0]["physical_ends"] = declarations() if ends is None else ends
    draft = create(owner, project, harness)
    frozen = capture(owner, draft)
    recipe = freeze(
        owner, create_profile(owner, project, profile(stock["revision_id"], body["revision_id"]))
    )
    request = {
        "harness_revision_id": frozen["revision_id"],
        "section_id": "shared",
        "profile_revision_id": recipe["revision_id"],
        "a_physical_end_id": "cut-two",
        "b_physical_end_id": "cut-one",
        "mapping_basis": "Explicit reversed profile mapping",
        "mapping_review": "reviewed",
    }
    return harness, draft, frozen, recipe, request


def test_exact_shared_piece_reverse_mapping_and_no_writeback(users, project):
    harness, draft, frozen, _, request = setup(users, project)
    before = {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()}
    result = op(users["viewer"], "end_preparation.apply_harness", request)
    assert result["physical_piece_count"] == 1 and result["section_id"] == "shared"
    assert [e["physical_end"]["local_id"] for e in result["ends"]] == ["cut-two", "cut-one"]
    assert [e["endpoint"]["local_id"] for e in result["ends"]] == ["output", "input"]
    assert (
        result["ends"][0]["instructions"][0]["instruction"]["length"]["nominal_mm"] == "12.500001"
    )
    assert result["ends"][1]["instructions"][0]["unresolved"] == ["minus_mm", "plus_mm"]
    assert result["harness_sha256"] == frozen["sha256"]
    assert all(not r["bond_created"] for e in result["ends"] for r in e["instructions"])
    assert result["actual_bonds"] == result["physical_qualification"] == "not_evaluated"
    assert {str(s.id): bytes(s.canonical) for s in Snapshot.objects.all()} == before
    harness["sections"][0]["physical_ends"][0]["basis"] = "Later synthetic review"
    updated = op(
        users["owner"],
        "harness.update",
        {"draft_id": draft["draft_id"], "harness": harness},
        expected_state=frozen["draft"]["state"],
    )
    later = capture(users["owner"], updated)
    assert later["revision_id"] != frozen["revision_id"]
    assert op(users["viewer"], "end_preparation.apply_harness", request) == result


@pytest.mark.parametrize("count", [0, 1, 3])
def test_absent_partial_and_multiend_sections_return_unknown_without_guessing(
    users, project, count
):
    ends = declarations()
    if count == 3:
        ends.append(
            {
                **ends[0],
                "local_id": "third-cut",
                "segment_ends": [{"segment_id": "trunk", "end": "a"}],
            }
        )
    *_, request = setup(users, project, ends[:count])
    result = op(users["owner"], "end_preparation.apply_harness", request)
    assert result["ends"] == [] and result["status"] == "unresolved" and result["unresolved"]
    assert len(result["declared_physical_ends"]) == count


def test_missing_mapping_and_endpoint_remain_unknown(users, project):
    ends = declarations()
    ends[1]["endpoint_id"] = None
    *_, request = setup(users, project, ends)
    result = op(users["owner"], "end_preparation.apply_harness", request)
    row = result["ends"][0]["instructions"][-1]
    assert row["unresolved"] == ["physical_end_endpoint"] and row["status"] == "incomplete_intent"
    result = op(
        users["owner"], "end_preparation.apply_harness", {**request, "a_physical_end_id": None}
    )
    assert result["status"] == "unresolved" and result["ends"] == []


@pytest.mark.parametrize("change", ["cross-section", "duplicate", "missing-endpoint"])
def test_invalid_physical_declarations_rejected_without_write(users, project, change):
    _, _, _, harness = fixture(users["owner"], project)
    ends = declarations()
    if change == "cross-section":
        ends[0]["segment_ends"][0]["segment_id"] = "leg-two"
    elif change == "duplicate":
        ends[1]["segment_ends"] = copy.deepcopy(ends[0]["segment_ends"])
    else:
        ends[0]["endpoint_id"] = "absent"
    harness["sections"][0]["physical_ends"] = ends
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, harness)


def test_full_unselected_closure_before_section_diagnostics_and_current_actor(users, project):
    harness, _, _, _, request = setup(users, project)
    hidden_project = op(users["owner"], "project.create", {"name": "Synthetic private stock"})[
        "project_id"
    ]
    stock, _, _, _ = fixture(users["owner"], hidden_project)
    harness["sections"][1]["stock_revision_id"] = stock["revision_id"]
    target = capture(users["owner"], create(users["owner"], project, harness))
    request.update(harness_revision_id=target["revision_id"], section_id="missing")
    Membership.objects.filter(project_id=hidden_project, user=users["owner"]).delete()
    with pytest.raises(NotFound):
        op(users["owner"], "end_preparation.apply_harness", request)
    with pytest.raises(NotFound):
        inspect_revision(users["owner"], target["revision_id"])
    get_user_model().objects.filter(id=users["owner"].id).update(is_active=False)
    with pytest.raises(Unauthenticated):
        api.calculate_harness(SimpleNamespace(user=users["owner"]), ApplyHarnessProfile(**request))


@pytest.mark.parametrize("legacy", [False, True])
def test_retained_harness_authority_before_changed_target_mismatch(users, project, legacy):
    owner = users["owner"]
    other = op(owner, "project.create", {"name": "Synthetic shared stock origin"})["project_id"]
    _, _, _, retained_content = fixture(owner, other)
    retained_content["sections"][0]["physical_ends"] = declarations()
    stored = create(owner, project, retained_content, idempotency_key="physical-ends")
    _, _, _, visible = fixture(owner, project)
    if legacy:
        IdempotencyRecord.objects.filter(
            actor=owner, operation="harness.create", key="physical-ends"
        ).update(scope="legacy")
    with pytest.raises(Conflict if legacy else IdempotencyMismatch):
        create(owner, project, visible, idempotency_key="physical-ends")
    Membership.objects.filter(project_id=other, user=owner).delete()
    visible["sections"][0]["physical_ends"] = declarations()
    visible["sections"][0]["physical_ends"][0]["segment_ends"][0]["segment_id"] = "missing"
    with pytest.raises(NotFound):
        create(owner, project, visible, idempotency_key="physical-ends")
    assert (
        stored["content"]["harness"]["sections"][0]["physical_ends"]
        == retained_content["sections"][0]["physical_ends"]
    )


@pytest.mark.parametrize("change", ["wrong-stock", "wrong-body", "same-end", "unknown-end"])
def test_exact_application_rejects_mismatched_pins(users, project, change):
    harness, _, _, _, request = setup(users, project)
    if change in {"wrong-stock", "wrong-body"}:
        stock, body, pins, _ = fixture(users["owner"], project)
        if change == "wrong-stock":
            harness["sections"][0]["stock_revision_id"] = stock["revision_id"]
        else:
            harness["endpoints"][1].update(
                body_revision_id=body["revision_id"], pinout_revision_id=pins["revision_id"]
            )
        target = capture(users["owner"], create(users["owner"], project, harness))
        request["harness_revision_id"] = target["revision_id"]
    else:
        request["a_physical_end_id"] = "cut-one" if change == "same-end" else "missing"
    with pytest.raises(ValidationFailed):
        op(users["owner"], "end_preparation.apply_harness", request)


def test_unreviewed_physical_identity_and_http_readonly_projection(users, project):
    ends = declarations()
    ends[1]["review"] = "unreviewed"
    *_, request = setup(users, project, ends)
    client = Client()
    client.force_login(users["viewer"])
    response = client.post(
        "/api/v0/end-preparation/apply-harness", request, content_type="application/json"
    )
    assert response.status_code == 200
    assert response.json()["ends"][0]["instructions"][0]["status"] == "unreviewed_intent"
    client.force_login(users["outsider"])
    assert (
        client.post(
            "/api/v0/end-preparation/apply-harness", request, content_type="application/json"
        ).status_code
        == 404
    )


def test_all_supplied_profile_authority_precedes_missing_section(users, project):
    *_, request = setup(users, project)
    other = op(users["owner"], "project.create", {"name": "Synthetic profile source"})["project_id"]
    stock, _, _, _ = fixture(users["owner"], other)
    recipe = freeze(
        users["owner"], create_profile(users["owner"], other, profile(stock["revision_id"]))
    )
    request.update(profile_revision_id=recipe["revision_id"], section_id="missing")
    Membership.objects.filter(project_id=other, user=users["owner"]).delete()
    with pytest.raises(NotFound):
        op(users["owner"], "end_preparation.apply_harness", request)


def test_legacy_retained_owner_denied_even_when_all_stock_references_remain_visible(users, project):
    owner = users["owner"]
    other = op(owner, "project.create", {"name": "Synthetic former harness owner"})["project_id"]
    _, _, _, harness = fixture(owner, project)
    create(owner, other, harness, idempotency_key="old-owner")
    IdempotencyRecord.objects.filter(
        actor=owner, operation="harness.create", key="old-owner"
    ).update(scope="legacy")
    with pytest.raises(Conflict):
        create(owner, project, harness, idempotency_key="old-owner")
    Membership.objects.filter(project_id=other, user=owner).delete()
    with pytest.raises(NotFound):
        create(owner, project, harness, idempotency_key="old-owner")
