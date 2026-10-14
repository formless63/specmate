"""BLD-002 pinned tool identity and BLD-006 reproducibility levels.

Runner behavior is simulated through its API operations over real PostgreSQL; no native
tool runs here, so nothing in this module claims native tool reproducibility.
"""
# ruff: noqa: F811  (shared pytest fixtures are imported by name)

import json

import pytest
from django.db import DatabaseError, IntegrityError, transaction
from django.test import Client

from specmate.builds.models import BuildAttempt, BuildStage, ReproducibilityComparison
from specmate.operations import Conflict, NotFound, PermissionDenied, Unsupported

from .conftest import op
from .test_build_recovery import retry
from .test_builds import (  # noqa: F401 - shared fixtures
    OUTPUT,
    RIGHTS,
    build_payload,
    credential,
    digest,
    fence,
    output_payload,
    recipe,
    runner_op,
    source,
    upload,
)

IMAGE_ID = "sha256:" + "c" * 64


def request(users, build_payload, key="first"):
    return op(users["owner"], "build.request", build_payload, idempotency_key=key)["build_id"]


def execute_success(users, credential, build_id, data=OUTPUT, image_id=None, http=False):
    """Dispatch, lease, upload one declared output and complete successfully."""
    op(users["owner"], "build.dispatch", {"build_id": build_id})
    lease = runner_op(credential, "runner.lease")["lease"]
    assert lease["build_id"] == build_id
    spec = lease["recipe"]["outputs"][0]
    upload(
        credential,
        lease,
        {
            **output_payload(lease),
            "path": spec["path"],
            "media_type": spec["media_type"],
            "sha256": digest(data),
            "size": len(data),
        },
        data=data,
    )
    receipt = {
        "outcome": "succeeded",
        "exit_code": 0,
        "outputs": [{"path": spec["path"], "sha256": digest(data)}],
        **({"image_id": image_id} if image_id else {}),
    }
    if http:
        # The runner's real transport: the route's request model decides which fields survive.
        response = Client().post(
            f"/api/v0/runner/stages/{lease['stage_id']}/complete",
            {"request_id": "http-complete", "fencing_token": lease["fencing_token"], **receipt},
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {credential['token']}",
        )
        assert response.status_code == 200, response.content
    else:
        runner_op(credential, "runner.complete", {**fence(lease), **receipt})
    return lease


def reproduce(user, build_id, key="repro-1", **kw):
    stage = BuildStage.objects.get(build_id=build_id)
    return op(
        user,
        "build.reproduce",
        {"build_id": build_id},
        expected_state=kw.pop("expected_state", f"stage-v{stage.version}"),
        idempotency_key=key,
    )


def history(user, build_id):
    return op(user, "build.history", {"build_id": build_id})


def json_report(recipe):
    recipe["outputs"] = [
        {"path": "report.json", "media_type": "application/json", "rights": RIGHTS}
    ]


# --- BLD-002: the pinned tool identity survives later approval changes -------------------


def test_changed_approval_keeps_pins_and_refuses_retry(users, build_payload, credential, settings):
    original = json.loads(json.dumps(settings.SPECMATE_APPROVED_RECIPES["synthetic-check-r1"]))
    first = request(users, build_payload)
    op(users["owner"], "build.dispatch", {"build_id": first})
    lease = runner_op(credential, "runner.lease")["lease"]
    runner_op(credential, "runner.complete", {**fence(lease), "outcome": "failed", "exit_code": 2})

    changed = json.loads(json.dumps(original))
    changed["image"] = "example.invalid/test@sha256:" + "2" * 64
    changed["argv"] = ["/tool", "--changed"]
    changed["limits"]["timeout_seconds"] = 120
    settings.SPECMATE_APPROVED_RECIPES = {"synthetic-check-r1": changed}

    expected = {
        "recipe_id": "synthetic-check-r1",
        "image": original["image"],
        "image_digest": "sha256:" + "1" * 64,
        "argv": original["argv"],
        "limits": original["limits"],
        "network": "none",
        "resolved_image_id": None,
    }
    assert BuildAttempt.objects.get(id=first).recipe["image"] == original["image"]
    assert history(users["viewer"], first)["pinned"] == expected
    assert op(users["viewer"], "build.get", {"build_id": first})["pinned"] == expected
    with pytest.raises(Conflict):
        retry(users["owner"], {"build_id": first})
    assert BuildAttempt.objects.count() == 1


def test_accepted_output_reports_pins_and_resolved_image_after_default_change(
    users, build_payload, credential, settings
):
    first = request(users, build_payload)
    execute_success(users, credential, first, image_id=IMAGE_ID)
    settings.SPECMATE_APPROVED_RECIPES["synthetic-check-r1"]["limits"]["timeout_seconds"] = 5
    output_id = str(BuildStage.objects.get(build_id=first).outputs.get().id)
    read = op(users["viewer"], "build.output", {"build_id": first, "output_id": output_id})
    assert read["pinned"]["limits"]["timeout_seconds"] == 60
    assert read["pinned"]["image_digest"] == "sha256:" + "1" * 64
    assert read["pinned"]["resolved_image_id"] == IMAGE_ID
    assert read["reproducibility"]["level"] == "provenance"


def test_resolved_image_id_sent_over_the_runner_http_route_is_stored(
    users, build_payload, credential
):
    first = request(users, build_payload)
    execute_success(users, credential, first, image_id=IMAGE_ID, http=True)
    stage = BuildStage.objects.get(build_id=first)
    assert stage.receipt["image_id"] == IMAGE_ID
    output_id = str(stage.outputs.get().id)
    read = op(users["viewer"], "build.output", {"build_id": first, "output_id": output_id})
    assert read["pinned"]["resolved_image_id"] == IMAGE_ID


def test_malformed_resolved_image_identity_is_refused(users, build_payload, credential):
    first = request(users, build_payload)
    op(users["owner"], "build.dispatch", {"build_id": first})
    lease = runner_op(credential, "runner.lease")["lease"]
    from specmate.operations import ValidationFailed

    with pytest.raises(ValidationFailed):
        runner_op(
            credential,
            "runner.complete",
            {**fence(lease), "outcome": "failed", "exit_code": 1, "image_id": "latest"},
        )


# --- BLD-006: levels are derived from independent repeated outputs -----------------------


def test_single_success_is_only_provenance(users, build_payload, credential):
    """ACC-BLD-006: a tool success alone never displays byte-reproducible."""
    first = request(users, build_payload)
    execute_success(users, credential, first)
    read = history(users["viewer"], first)
    assert read["state"] == "succeeded" and read["receipt"]["exit_code"] == 0
    assert read["reproducibility"]["level"] == "provenance"
    assert read["outputs"][0]["reproducibility"] == "provenance"
    assert read["comparisons"] == []
    assert op(users["viewer"], "build.get", {"build_id": first})["reproducibility"] == "provenance"
    listed = op(users["viewer"], "build.list", {"workspace_id": build_payload["workspace_id"]})
    assert listed["builds"][0]["reproducibility"] == "provenance"
    assert not ReproducibilityComparison.objects.exists()


def test_identical_rerun_is_byte_reproducible_for_both_attempts(users, build_payload, credential):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    second = reproduce(users["owner"], first)
    assert second["reproduction_of"] == first and second["build_id"] != first
    attempt = BuildAttempt.objects.get(id=second["build_id"])
    original = BuildAttempt.objects.get(id=first)
    assert (
        attempt.input_key == original.input_key and attempt.staged_inputs == original.staged_inputs
    )
    assert history(users["viewer"], first)["reproducibility"]["level"] == "provenance"
    execute_success(users, credential, second["build_id"])
    for build_id in (first, second["build_id"]):
        read = history(users["viewer"], build_id)
        assert read["reproducibility"]["level"] == "byte_reproducible"
        assert read["reproducibility"]["outputs"]["result.txt"]["attempts_compared"] == 1
        assert read["comparisons"][0]["byte_identical"] is True
    row = ReproducibilityComparison.objects.get()
    assert (row.baseline_id, row.candidate_id) == (original.id, attempt.id)
    assert row.result == "not_needed" and row.comparator == ""
    assert history(users["viewer"], first)["reproductions"] == [second["build_id"]]


def test_differing_rerun_without_comparator_is_only_rerun_recorded(
    users, build_payload, credential
):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    second = reproduce(users["owner"], first)["build_id"]
    execute_success(users, credential, second, data=b"different synthetic result\n")
    read = history(users["viewer"], second)
    assert read["reproducibility"]["level"] == "rerun_recorded"
    assert read["comparisons"][0]["result"] == "none_declared"


def test_canonical_json_equality_is_semantic_not_byte(users, build_payload, credential, recipe):
    json_report(recipe)
    first = request(users, build_payload)
    execute_success(users, credential, first, data=b'{"b": 1, "a": [1, 2]}')
    second = reproduce(users["owner"], first)["build_id"]
    execute_success(users, credential, second, data=b'{"a":[1,2],"b":1}\n')
    third = reproduce(users["owner"], first, key="repro-2")["build_id"]
    execute_success(users, credential, third, data=b'{"a": [2, 1], "b": 1}')
    second_read = history(users["viewer"], second)
    assert second_read["reproducibility"]["level"] == "semantic_equality"
    assert second_read["reproducibility"]["outputs"]["report.json"]["comparators"] == [
        "json-canonical/1"
    ]
    # The third differs from both under the declared comparator: a rerun, nothing more.
    third_read = history(users["viewer"], third)
    assert third_read["reproducibility"]["level"] == "rerun_recorded"
    assert {c["result"] for c in third_read["comparisons"]} == {"different"}
    assert ReproducibilityComparison.objects.count() == 3


def test_unreadable_json_is_not_semantic_equality(users, build_payload, credential, recipe):
    json_report(recipe)
    first = request(users, build_payload)
    execute_success(users, credential, first, data=b"not json")
    second = reproduce(users["owner"], first)["build_id"]
    execute_success(users, credential, second, data=b"also not json")
    read = history(users["viewer"], second)
    assert read["reproducibility"]["level"] == "rerun_recorded"
    assert read["comparisons"][0]["result"] == "unreadable"


def test_independent_requests_over_identical_inputs_are_compared(users, build_payload, credential):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    second = request(users, build_payload, key="second")
    execute_success(users, credential, second)
    assert history(users["viewer"], second)["reproducibility"]["level"] == "byte_reproducible"


def test_changed_recipe_or_configuration_is_not_the_same_input(
    users, build_payload, credential, settings
):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    settings.SPECMATE_APPROVED_RECIPES["synthetic-check-r1"]["limits"]["timeout_seconds"] = 61
    second = request(users, build_payload, key="second")
    execute_success(users, credential, second)
    assert (
        BuildAttempt.objects.get(id=first).input_key
        != BuildAttempt.objects.get(id=second).input_key
    )
    assert history(users["viewer"], second)["reproducibility"]["level"] == "provenance"
    assert not ReproducibilityComparison.objects.exists()
    # The changed approval also blocks a reproducibility check of the earlier build.
    with pytest.raises(Conflict):
        reproduce(users["owner"], first)


def test_failed_rerun_records_no_comparison(users, build_payload, credential):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    second = reproduce(users["owner"], first)["build_id"]
    op(users["owner"], "build.dispatch", {"build_id": second})
    lease = runner_op(credential, "runner.lease")["lease"]
    runner_op(credential, "runner.complete", {**fence(lease), "outcome": "failed", "exit_code": 4})
    assert history(users["viewer"], first)["reproducibility"]["level"] == "provenance"
    assert history(users["viewer"], second)["reproducibility"] is None
    assert not ReproducibilityComparison.objects.exists()


# --- request reproducibility check: authority, state and replay --------------------------


def test_reproduce_requires_execution_authority_and_an_accepted_build(
    users, build_payload, credential, settings
):
    first = request(users, build_payload)
    with pytest.raises(Conflict):
        reproduce(users["owner"], first)
    execute_success(users, credential, first)
    with pytest.raises(PermissionDenied):
        reproduce(users["viewer"], first)
    with pytest.raises(PermissionDenied):
        reproduce(users["editor"], first)
    with pytest.raises(NotFound):
        reproduce(users["outsider"], first)
    with pytest.raises(Conflict):
        reproduce(users["owner"], first, expected_state="stage-v1")
    assert history(users["owner"], first)["reproduce_available"] is True
    settings.SPECMATE_APPROVED_RECIPES = {}
    with pytest.raises(Unsupported):
        reproduce(users["owner"], first)
    assert BuildAttempt.objects.count() == 1


def test_reproduce_replay_returns_the_same_attempt(users, build_payload, credential):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    one = reproduce(users["owner"], first)
    again = reproduce(users["owner"], first)
    assert one == again and BuildAttempt.objects.count() == 2
    # Repeated checks are allowed; each is a new independent attempt.
    other = reproduce(users["owner"], first, key="repro-2")
    assert other["build_id"] not in (one["build_id"], first)
    events = history(users["viewer"], one["build_id"])["events"]
    assert events[0]["detail"]["reproduction_of"] == first


def test_comparisons_are_append_only(users, build_payload, credential):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    execute_success(users, credential, reproduce(users["owner"], first)["build_id"])
    with pytest.raises(DatabaseError), transaction.atomic():
        ReproducibilityComparison.objects.update(byte_identical=False, result="different")
    with pytest.raises(DatabaseError), transaction.atomic():
        ReproducibilityComparison.objects.all().delete()


def test_database_refuses_comparison_across_input_keys(users, build_payload, credential, settings):
    first = request(users, build_payload)
    execute_success(users, credential, first)
    settings.SPECMATE_APPROVED_RECIPES["synthetic-check-r1"]["limits"]["pids"] = 8
    second = request(users, build_payload, key="second")
    a, b = BuildAttempt.objects.get(id=first), BuildAttempt.objects.get(id=second)
    with pytest.raises(IntegrityError), transaction.atomic():
        ReproducibilityComparison.objects.create(
            workspace_id=a.workspace_id,
            input_key=a.input_key,
            baseline=a,
            candidate=b,
            path="result.txt",
            media_type="text/plain",
            baseline_sha256=digest(OUTPUT),
            candidate_sha256=digest(OUTPUT),
            byte_identical=True,
            result="not_needed",
        )


def test_package_level_is_bounded_by_evidence_time(users, build_payload, credential):
    """A retained manifest rebuilds exactly; later reruns only strengthen fresh packages."""
    from specmate.export_packages.queries import reproducibility

    first = request(users, build_payload)
    execute_success(users, credential, first)
    attempt = BuildAttempt.objects.select_related("stage").get(id=first)
    before = attempt.stage.updated_at
    execute_success(users, credential, reproduce(users["owner"], first)["build_id"])
    assert reproducibility(attempt, before) == {
        "level": "provenance",
        "outputs": {"result.txt": "provenance"},
    }
    assert reproducibility(attempt, None)["level"] == "byte_reproducible"
