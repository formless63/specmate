"""CFG-001 / BLD: a build may pin an exact, complete resolved configuration."""
# ruff: noqa: F811

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.builds.models import BuildAttempt
from specmate.operations import IdempotencyMismatch, NotFound, ValidationFailed

from .conftest import member, op
from .scope_helpers import workspace_of
from .test_builds import (  # noqa: F401
    build_payload,
    credential,
    digest,
    recipe,
    runner_op,
    source,
)
from .test_configurations import (  # noqa: F401
    capture,
    configuration,
    frozen,
    option_set_content,
    parts,
    select,
)

FINISH = [
    {"option_key": "finish", "choice_key": "paint"},
    {"option_key": "sealing", "choice_key": None},
]


def resolved(users, scope, *, complete=True):
    part_revisions = [frozen(users["owner"], scope, f"Synthetic sensor {n}") for n in ("A", "B")]
    created = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(scope),
            "kind": "option_set",
            "name": "Synthetic options",
            "content": option_set_content(part_revisions),
        },
    )
    option_set = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    draft = configuration(users["owner"], scope, option_set["revision_id"])
    if complete:
        select(users["owner"], draft, FINISH)
    return capture(users["owner"], draft["draft_id"])


@pytest.fixture
def complete(users, project):
    return resolved(users, project)


def request(users, payload, key, actor="owner"):
    return op(users[actor], "build.request", payload, idempotency_key=key)


def test_build_pins_exact_configuration_in_inputs_history_and_record(
    users, build_payload, complete, credential
):
    pinned = {**build_payload, "resolved_configuration_id": complete["resolved_configuration_id"]}
    first = request(users, pinned, "pinned")
    assert request(users, pinned, "pinned") == first
    assert BuildAttempt.objects.count() == 1
    expected = op(
        users["owner"],
        "configuration.build_input",
        {"resolved_configuration_id": complete["resolved_configuration_id"]},
    )
    build = BuildAttempt.objects.get(id=first["build_id"])
    assert str(build.resolved_configuration_id) == complete["resolved_configuration_id"]
    assert build.configuration_input == expected
    history = op(users["owner"], "build.history", {"build_id": first["build_id"]})
    assert history["configuration"] == expected
    # Staged runner inputs carry the exact pin.
    op(users["owner"], "build.dispatch", {"build_id": first["build_id"]})
    lease = runner_op(credential, "runner.lease")["lease"]
    assert lease["configuration"] == expected
    # An unpinned build records no configuration, and a different pin is a different request.
    plain = request(users, build_payload, "plain")
    assert BuildAttempt.objects.get(id=plain["build_id"]).configuration_input is None
    assert (
        op(users["owner"], "build.history", {"build_id": plain["build_id"]})["configuration"]
        is None
    )
    with pytest.raises(IdempotencyMismatch):
        request(users, build_payload, "pinned")


def test_incomplete_configuration_is_refused_without_a_build(users, build_payload, project):
    incomplete = resolved(users, project, complete=False)
    with pytest.raises(ValidationFailed) as refused:
        request(
            users,
            {**build_payload, "resolved_configuration_id": incomplete["resolved_configuration_id"]},
            "incomplete",
        )
    assert refused.value.details == {"unresolved": ["finish"]}
    assert not BuildAttempt.objects.exists()


def test_other_workspace_configuration_is_not_found_before_the_database_guard(
    users, build_payload, other_workspace
):
    member(users["owner"], "admin", workspace=other_workspace)
    foreign = resolved(users, other_workspace)
    with pytest.raises(NotFound):
        request(
            users,
            {**build_payload, "resolved_configuration_id": foreign["resolved_configuration_id"]},
            "foreign",
        )
    with pytest.raises(NotFound):
        request(
            users,
            {**build_payload, "resolved_configuration_id": "00000000-0000-4000-8000-000000000000"},
            "missing",
        )
    assert not BuildAttempt.objects.exists()


def test_retry_keeps_the_original_configuration_pin(users, build_payload, complete, credential):
    pinned = {**build_payload, "resolved_configuration_id": complete["resolved_configuration_id"]}
    first = request(users, pinned, "pinned")
    op(users["owner"], "build.dispatch", {"build_id": first["build_id"]})
    lease = runner_op(credential, "runner.lease")["lease"]
    runner_op(
        credential,
        "runner.complete",
        {
            "stage_id": lease["stage_id"],
            "fencing_token": lease["fencing_token"],
            "outcome": "failed",
            "exit_code": 2,
            "message": "synthetic failure",
        },
    )
    retried = op(
        users["owner"],
        "build.retry",
        {"build_id": first["build_id"]},
        expected_state=op(users["owner"], "build.get", {"build_id": first["build_id"]})[
            "state_token"
        ],
        idempotency_key="retry",
    )
    original = BuildAttempt.objects.get(id=first["build_id"])
    again = BuildAttempt.objects.get(id=retried["build_id"])
    assert again.resolved_configuration_id == original.resolved_configuration_id
    assert again.configuration_input == original.configuration_input


def test_database_rejects_mismatched_or_unpinned_configuration(
    users, build_payload, complete, other_workspace
):
    plain = request(users, build_payload, "plain")
    row = BuildAttempt.objects.get(id=plain["build_id"])
    member(users["owner"], "admin", workspace=other_workspace)
    foreign = resolved(users, other_workspace)
    for configuration_id, pinned in (
        (foreign["resolved_configuration_id"], {"x": 1}),  # other workspace
        (complete["resolved_configuration_id"], None),  # id without retained input
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            BuildAttempt.objects.create(
                workspace_id=row.workspace_id,
                requested_by=row.requested_by,
                source_revision_id=row.source_revision_id,
                recipe_id=row.recipe_id,
                recipe=row.recipe,
                workflow_id=f"x-{configuration_id}",
                resolved_configuration_id=configuration_id,
                configuration_input=pinned,
            )
    assert connection.in_atomic_block


def test_resolved_configurations_list_for_selection(users, complete, project, other_workspace):
    listed = op(
        users["viewer"], "configuration.list_resolved", {"workspace_id": workspace_of(project)}
    )
    assert [r["resolved_configuration_id"] for r in listed["resolved"]] == [
        complete["resolved_configuration_id"]
    ]
    assert listed["resolved"][0]["status"] == "complete"
    with pytest.raises(NotFound):
        op(users["viewer"], "configuration.list_resolved", {"workspace_id": other_workspace})
