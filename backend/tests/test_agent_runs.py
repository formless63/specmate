"""Bounded agent runs (AGT-002) and their lifecycle/review (AGT-004).

Synthetic workspace fixture: an editor sponsors a run for a viewer-role agent account,
which can change nothing by itself and acts only through the run.
"""

from datetime import timedelta

import pytest
from django.db import DatabaseError, transaction
from django.utils import timezone

from specmate.agent_runs.models import AgentRun, AgentRunStep
from specmate.design.models import Definition, Draft, Revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import member, op, set_role
from .test_transports import api, post_op


def deadline(hours=4):
    return (timezone.now() + timedelta(hours=hours)).isoformat()


def start(users, workspace, sponsor="editor", agent="viewer", **extra):
    payload = {
        "workspace_id": workspace,
        "title": "Synthetic draft cleanup",
        "purpose": "Normalize synthetic stock drafts",
        "agent_username": agent,
        "allowed_actions": ["definition.create", "draft.update"],
        "max_actions": 10,
        "deadline": deadline(),
        **extra,
    }
    return op(users[sponsor], "agent_run.create", payload)["run"]


def act(users, run, key, operation, payload, who="viewer", **ctx):
    return op(
        users[who],
        "agent_run.act",
        {
            "run_id": run["run_id"],
            "step_key": key,
            "operation": operation,
            "payload": payload,
            **ctx,
        },
    )


def new_stock(users, run, workspace, key="s1", content=None):
    out = act(
        users,
        run,
        key,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "wire_stock",
            "name": "Synthetic stock",
            "content": content or {"gauge": "unknown"},
        },
    )
    assert out["step"]["outcome"] == "applied", out["step"]["error"]
    return out["step"]["result"]


def read(users, run, who="editor"):
    return op(users[who], "agent_run.read", {"run_id": run["run_id"]})


def package(users, run, who="editor"):
    return op(users[who], "agent_run.review_package", {"run_id": run["run_id"]})


# ---- AGT-002: bounded draft autonomy ---------------------------------------------


def test_draft_sequence_proceeds_and_stops_at_ungranted_freeze(users, workspace):
    run = start(users, workspace)
    created = new_stock(users, run, workspace)
    # The agent account is a viewer: it cannot edit the draft itself.
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "draft.update",
            {"draft_id": created["draft_id"], "changes": {"gauge": "22"}},
            expected_state=created["state"],
        )
    state = created["state"]
    for number, gauge in enumerate(["22", "24"], start=2):
        out = act(
            users,
            run,
            f"s{number}",
            "draft.update",
            {"draft_id": created["draft_id"], "changes": {"gauge": gauge}},
            expected_state=state,
        )
        assert out["step"]["outcome"] == "applied"
        state = out["step"]["result"]["state"]
    draft = Draft.objects.get(id=created["draft_id"])
    assert draft.content == {"gauge": "24"} and draft.updated_by == users["editor"]

    stop = act(
        users, run, "s4", "draft.freeze", {"draft_id": created["draft_id"]}, expected_state=state
    )
    assert stop["step"]["kind"] == "boundary" and stop["step"]["outcome"] == "blocked"
    assert stop["run"]["status"] == "paused"
    assert "draft.freeze" in stop["run"]["status_reason"]
    assert stop["run"]["budget"]["actions_used"] == 3
    assert not Revision.objects.filter(definition_id=created["definition_id"]).exists()
    with pytest.raises(Conflict):
        act(
            users,
            run,
            "s5",
            "draft.update",
            {"draft_id": created["draft_id"]},
            expected_state=state,
        )


def test_grant_must_be_draft_level_and_within_sponsor_permissions(users, workspace):
    with pytest.raises(ValidationFailed) as boundary:
        start(users, workspace, allowed_actions=["draft.update", "draft.freeze"])
    assert "boundary_actions" in str(boundary.value.details)
    for name in ["build.request", "inventory.consume", "workspace.set_member", "project.delete"]:
        with pytest.raises(ValidationFailed):
            start(users, workspace, sponsor="owner", allowed_actions=[name])
    for name in ["agent_run.act", "runner.lease", "source.register_blob", "no.such_op"]:
        with pytest.raises(ValidationFailed):
            start(users, workspace, sponsor="owner", allowed_actions=[name])
    # The grant is a subset of the sponsor: a contributor cannot grant edits or freezing.
    with pytest.raises(ValidationFailed) as edit:
        start(users, workspace, sponsor="contributor", allowed_actions=["draft.update"])
    assert "sponsor lacks design.edit" in str(edit.value.details)
    with pytest.raises(ValidationFailed):
        start(
            users,
            workspace,
            sponsor="contributor",
            allowed_actions=["definition.create"],
            boundary_actions=["draft.freeze"],
        )
    with pytest.raises(PermissionDenied):
        start(users, workspace, sponsor="viewer", allowed_actions=["discovery.capabilities"])
    with pytest.raises(ValidationFailed):
        start(users, workspace, deadline=(timezone.now() - timedelta(minutes=1)).isoformat())
    with pytest.raises(ValidationFailed):
        start(users, workspace, deadline=deadline(hours=24 * 31))
    with pytest.raises(NotFound):
        start(users, workspace, agent="outsider")
    assert not AgentRun.objects.exists()


def test_explicit_boundary_grant_allows_that_boundary_only(users, workspace):
    run = start(users, workspace, boundary_actions=["draft.freeze"])
    created = new_stock(users, run, workspace)
    frozen = act(
        users,
        run,
        "f1",
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    assert frozen["step"]["outcome"] == "applied"
    assert Revision.objects.filter(definition_id=created["definition_id"]).count() == 1
    blocked = act(users, run, "f2", "cable.freeze", {"draft_id": created["draft_id"]})
    assert blocked["step"]["kind"] == "boundary"


def test_ungranted_draft_operation_is_refused_without_record(users, workspace):
    run = start(users, workspace)
    with pytest.raises(PermissionDenied):
        act(users, run, "x1", "project.create", {"name": "Not granted"})
    assert AgentRunStep.objects.filter(run_id=run["run_id"]).count() == 1  # created only
    with pytest.raises(PermissionDenied):
        act(users, run, "x2", "draft.update", {}, who="contributor")


def test_run_cannot_reach_other_workspaces_of_the_sponsor(users, workspace, other_workspace):
    member(users["editor"], "admin", workspace=other_workspace)
    foreign = op(
        users["editor"],
        "definition.create",
        {"workspace_id": other_workspace, "kind": "wire_stock", "name": "Foreign", "content": {}},
    )
    run = start(users, workspace)
    out = act(
        users,
        run,
        "w1",
        "draft.update",
        {"draft_id": foreign["draft_id"], "changes": {"gauge": "1"}},
        expected_state=foreign["state"],
    )
    assert out["step"]["outcome"] == "failed"
    assert out["step"]["error"]["code"] == "not_found"
    assert Draft.objects.get(id=foreign["draft_id"]).content == {}
    created = act(
        users,
        run,
        "w2",
        "definition.create",
        {"workspace_id": other_workspace, "kind": "wire_stock", "name": "X", "content": {}},
    )
    assert created["step"]["error"]["code"] == "not_found"


def test_delegation_scopes_one_account_to_one_workspace_and_cap(users, workspace, other_workspace):
    from specmate.access.permissions import (
        ROLE_PERMISSIONS,
        Perm,
        delegated,
        held_permissions,
        member_workspaces,
        membership,
    )

    member(users["owner"], "admin", workspace=other_workspace)
    cap = frozenset({Perm.WORKSPACE_READ, Perm.DESIGN_EDIT})
    with delegated(users["owner"].pk, workspace, cap):
        assert held_permissions(users["owner"], workspace) == cap
        assert membership(users["owner"], other_workspace) is None
        assert [str(w.id) for w in member_workspaces(users["owner"])] == [workspace]
        assert held_permissions(users["editor"], workspace) == ROLE_PERMISSIONS["editor"]
    assert Perm.WORKSPACE_ADMIN in held_permissions(users["owner"], workspace)
    assert membership(users["owner"], other_workspace) is not None


def test_budget_counts_failures_and_stops_the_run(users, workspace):
    run = start(users, workspace, max_actions=2)
    failed = act(users, run, "b1", "draft.update", {"draft_id": run["run_id"]}, expected_state="x")
    assert failed["step"]["outcome"] == "failed" and failed["step"]["budget_consumed"] == 1
    new_stock(users, run, workspace, key="b2")
    state = read(users, run)["run"]
    assert state["status"] == "exhausted"
    assert state["budget"] == {
        "max_actions": 2,
        "actions_used": 2,
        "actions_remaining": 0,
        "checkpoint_every": None,
        "actions_since_checkpoint": 1,
    }
    with pytest.raises(Conflict):
        new_stock(users, run, workspace, key="b3")


def test_deadline_stops_the_run(users, workspace):
    run = start(users, workspace)
    AgentRun.objects.filter(id=run["run_id"]).update(
        deadline=timezone.now() - timedelta(seconds=1), version=5
    )
    assert read(users, run)["run"]["status"] == "expired"
    with pytest.raises(Conflict):
        new_stock(users, run, workspace)
    listed = op(users["viewer"], "agent_run.list", {"workspace_id": workspace, "status": "expired"})
    assert [r["run_id"] for r in listed["runs"]] == [run["run_id"]]


def test_checkpoint_every_pauses_for_review(users, workspace):
    run = start(users, workspace, checkpoint_every=2)
    new_stock(users, run, workspace, key="c1")
    out = act(
        users,
        run,
        "c2",
        "definition.create",
        {"workspace_id": workspace, "kind": "wire_stock", "name": "Two", "content": {}},
    )
    assert out["run"]["status"] == "paused"
    kinds = [s["kind"] for s in read(users, run)["steps"]]
    assert kinds == ["lifecycle", "action", "action", "checkpoint"]


# ---- AGT-004: lifecycle, resume and review ----------------------------------------


def test_resume_replays_recorded_steps_without_repeating_or_consuming(users, workspace):
    run = start(users, workspace, max_actions=3)
    created = new_stock(users, run, workspace, key="k1")
    first = act(
        users,
        run,
        "k2",
        "draft.update",
        {"draft_id": created["draft_id"], "changes": {"gauge": "20"}},
        expected_state=created["state"],
    )
    paused = op(
        users["viewer"],
        "agent_run.checkpoint",
        {"run_id": run["run_id"], "note": "Halfway", "pause": True},
    )["run"]
    assert paused["status"] == "paused"
    # A retry while paused returns the exact recorded result: nothing reruns.
    again = act(
        users,
        run,
        "k2",
        "draft.update",
        {"draft_id": created["draft_id"], "changes": {"gauge": "20"}},
        expected_state=created["state"],
    )
    assert again["replayed"] is True and again["step"] == first["step"]
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "agent_run.resume",
            {"run_id": run["run_id"]},
            expected_state=paused["state"],
        )
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "agent_run.resume",
            {"run_id": run["run_id"]},
            expected_state="agent-run-v1",
        )
    resumed = op(
        users["editor"],
        "agent_run.resume",
        {"run_id": run["run_id"], "add_actions": 1},
        expected_state=paused["state"],
    )["run"]
    assert resumed["status"] == "active"
    assert resumed["budget"]["actions_used"] == 2 and resumed["budget"]["max_actions"] == 4
    replay = act(
        users,
        run,
        "k2",
        "draft.update",
        {"draft_id": created["draft_id"], "changes": {"gauge": "20"}},
        expected_state=created["state"],
    )
    assert replay["replayed"] is True and replay["run"]["budget"]["actions_used"] == 2
    assert Draft.objects.get(id=created["draft_id"]).version == 2
    with pytest.raises(IdempotencyMismatch):
        act(users, run, "k2", "draft.update", {"draft_id": created["draft_id"]})
    after = act(
        users,
        run,
        "k3",
        "draft.update",
        {"draft_id": created["draft_id"], "changes": {"gauge": "18"}},
        expected_state=first["step"]["result"]["state"],
    )
    assert after["run"]["budget"]["actions_used"] == 3
    steps = read(users, run)["steps"]
    assert [s["step_key"] for s in steps if s["kind"] == "action"] == ["k1", "k2", "k3"]
    assert [s["outcome"] for s in steps if s["kind"] == "lifecycle"] == ["created", "resumed"]


def test_resume_after_boundary_can_grant_it_explicitly(users, workspace):
    run = start(users, workspace)
    created = new_stock(users, run, workspace)
    stop = act(
        users,
        run,
        "z1",
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    resumed = op(
        users["editor"],
        "agent_run.resume",
        {"run_id": run["run_id"], "grant_boundary_actions": ["draft.freeze"]},
        expected_state=stop["run"]["state"],
    )["run"]
    assert resumed["grant"]["boundary_actions"] == ["draft.freeze"]
    # The blocked key keeps its recorded stop; a new key performs the granted freeze.
    assert (
        act(
            users,
            run,
            "z1",
            "draft.freeze",
            {"draft_id": created["draft_id"]},
            expected_state=created["state"],
        )["step"]["outcome"]
        == "blocked"
    )
    done = act(
        users,
        run,
        "z2",
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    assert done["step"]["outcome"] == "applied"


def test_cancel_is_sponsor_or_admin_and_final(users, workspace):
    run = start(users, workspace)
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "agent_run.cancel", {"run_id": run["run_id"]})
    cancelled = op(users["owner"], "agent_run.cancel", {"run_id": run["run_id"], "note": "Stop"})
    assert cancelled["run"]["status"] == "cancelled"
    with pytest.raises(Conflict):
        new_stock(users, run, workspace)
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "agent_run.resume",
            {"run_id": run["run_id"], "add_actions": 1},
            expected_state=cancelled["run"]["state"],
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        AgentRun.objects.filter(id=run["run_id"]).update(status="active", version=99)


def test_review_package_lists_diffs_provenance_and_drift_and_reverts(users, workspace):
    run = start(users, workspace)
    created = new_stock(users, run, workspace, content={"gauge": "unknown", "old": 1})
    edit = act(
        users,
        run,
        "r2",
        "draft.update",
        {
            "draft_id": created["draft_id"],
            "changes": {"gauge": "22", "new": True},
            "remove": ["old"],
        },
        expected_state=created["state"],
    )
    act(users, run, "r3", "draft.freeze", {"draft_id": created["draft_id"]})
    op(
        users["viewer"],
        "agent_run.propose",
        {"run_id": run["run_id"], "summary": "Freeze r1", "operation": "draft.freeze"},
    )
    pkg = package(users, run, who="contributor")
    assert pkg["counts"]["applied"] == 2 and pkg["counts"]["boundary_stops"] == 1
    assert pkg["counts"]["proposals"] == 1
    records = {(c["step_number"], c["model"], c["action"]) for c in pkg["changes"]}
    assert (2, "design.definition", "created") in records
    assert (2, "design.draft", "created") in records
    update = next(c for c in pkg["changes"] if c["step_number"] == 3)
    assert update["diffs"]["content"] == {
        "added": {"new": True},
        "removed": {"old": 1},
        "changed": {"gauge": {"before": "unknown", "after": "22"}},
    }
    assert update["diffs"]["version"] == {"before": 1, "after": 2}
    assert update["provenance"]["agent"] == "viewer"
    assert update["provenance"]["on_behalf_of"] == "editor"
    assert update["current"] == "unchanged_since_step" and update["revertible"]
    assert len(pkg["log_sha256"]) == 64

    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "agent_run.revert_change",
            {"run_id": run["run_id"], "step_id": update["step_id"], "record": update["record"]},
        )
    op(users["viewer"], "agent_run.complete", {"run_id": run["run_id"], "note": "Done"})
    reverted = op(
        users["editor"],
        "agent_run.revert_change",
        {"run_id": run["run_id"], "step_id": update["step_id"], "record": update["record"]},
    )
    assert reverted["step"]["kind"] == "revert"
    draft = Draft.objects.get(id=created["draft_id"])
    assert draft.content == {"gauge": "unknown", "old": 1} and draft.version == 3
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "agent_run.revert_change",
            {"run_id": run["run_id"], "step_id": update["step_id"], "record": update["record"]},
        )
    after = package(users, run)
    change = next(c for c in after["changes"] if c["step_number"] == 3)
    assert change["reverted"] and not change["revertible"]
    assert change["current"] == "changed_since_step"
    assert edit["step"]["result"]["state"] == "draft-v2"


def test_review_decision_by_human_not_agent(users, workspace):
    run = start(users, workspace)
    with pytest.raises(Conflict):
        op(users["editor"], "agent_run.review", {"run_id": run["run_id"], "decision": "accepted"})
    op(users["viewer"], "agent_run.complete", {"run_id": run["run_id"]})
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "agent_run.review", {"run_id": run["run_id"], "decision": "accepted"})
    reviewed = op(
        users["owner"],
        "agent_run.review",
        {"run_id": run["run_id"], "decision": "changes_requested", "note": "Check gauge"},
    )["run"]
    assert reviewed["review"]["decision"] == "changes_requested"
    assert reviewed["review"]["reviewed_by"] == "owner"


def test_sponsor_losing_permission_stops_actions(users, workspace):
    run = start(users, workspace)
    set_role(users["editor"], "viewer")
    with pytest.raises(PermissionDenied):
        new_stock(users, run, workspace)
    assert AgentRunStep.objects.filter(run_id=run["run_id"]).count() == 1


def test_outsider_cannot_see_runs_and_steps_are_immutable(users, workspace):
    run = start(users, workspace)
    new_stock(users, run, workspace)
    for name in ["agent_run.read", "agent_run.review_package"]:
        with pytest.raises(NotFound):
            op(users["outsider"], name, {"run_id": run["run_id"]})
    with pytest.raises(NotFound):
        op(users["outsider"], "agent_run.list", {"workspace_id": workspace})
    with pytest.raises(NotFound):
        act(users, run, "o1", "draft.update", {}, who="outsider")
    with pytest.raises(DatabaseError), transaction.atomic():
        AgentRunStep.objects.filter(run_id=run["run_id"]).update(note="rewritten")
    with pytest.raises(DatabaseError), transaction.atomic():
        AgentRunStep.objects.filter(run_id=run["run_id"]).delete()


def test_http_entry_points_use_the_same_operations(users, workspace):
    run = start(users, workspace)
    client = api(users["viewer"])
    response = post_op(
        client,
        "agent_run.act",
        {
            "run_id": run["run_id"],
            "step_key": "h1",
            "operation": "definition.create",
            "payload": {
                "workspace_id": workspace,
                "kind": "wire_stock",
                "name": "H",
                "content": {},
            },
        },
    )
    assert response.status_code == 200, response.json()
    assert response.json()["result"]["step"]["outcome"] == "applied"
    listed = client.get(f"/api/v0/agent-runs?workspace_id={workspace}")
    assert [r["run_id"] for r in listed.json()["runs"]] == [run["run_id"]]
    assert listed["Cache-Control"] == "private, no-store"
    detail = client.get(f"/api/v0/agent-runs/{run['run_id']}").json()
    assert [s["step_key"] for s in detail["steps"]] == [None, "h1"]
    pkg = client.get(f"/api/v0/agent-runs/{run['run_id']}/review-package").json()
    assert pkg["counts"]["applied"] == 1
    assert api(users["outsider"]).get(f"/api/v0/agent-runs/{run['run_id']}").status_code == 404


def test_messaging_other_people_is_a_boundary_needing_explicit_grant(users, workspace):
    from specmate.agent_runs.grants import MESSAGING, classify

    for name in MESSAGING:
        assert classify(name)["boundary"] and classify(name)["reason"] == "notifies other people"
        with pytest.raises(ValidationFailed):
            start(users, workspace, allowed_actions=[name])
    run = start(users, workspace)
    stop = act(users, run, "m1", "collaboration.create", {"workspace_id": workspace})
    assert stop["step"]["kind"] == "boundary" and stop["run"]["status"] == "paused"
    granted = start(users, workspace, boundary_actions=["collaboration.create"])
    assert granted["grant"]["boundary_actions"] == ["collaboration.create"]


# ---- revert of records the run created --------------------------------------------


def _created_change(users, run, model="design.definition"):
    return next(
        c
        for c in package(users, run)["changes"]
        if c["model"] == model and c["action"] == "created"
    )


def _revert(users, run, change, who="editor"):
    return op(
        users[who],
        "agent_run.revert_change",
        {"run_id": run["run_id"], "step_id": change["step_id"], "record": change["record"]},
    )


def test_unreferenced_unfrozen_created_definition_is_discarded_and_logged(users, workspace):
    run = start(users, workspace)
    created = new_stock(users, run, workspace)
    op(users["viewer"], "agent_run.complete", {"run_id": run["run_id"]})
    change = _created_change(users, run)
    assert change["revertible"] and change["revert"] == {
        "kind": "discard",
        "revertible": True,
        "blockers": [],
    }
    with pytest.raises(PermissionDenied):
        _revert(users, run, change, who="viewer")
    out = _revert(users, run, change)
    assert out["step"]["kind"] == "revert"
    assert out["step"]["result"]["discarded"][0] == change["record"]
    assert not Definition.objects.filter(id=created["definition_id"]).exists()
    assert not Draft.objects.filter(id=created["draft_id"]).exists()
    models = {c["model"]: c["action"] for c in out["step"]["changes"]}
    assert models == {"design.definition": "deleted", "design.draft": "deleted"}
    pkg = package(users, run)
    assert pkg["counts"]["reverts"] == 1
    # Both the definition and its draft show as reverted; neither can be reverted again.
    created_rows = [c for c in pkg["changes"] if c["action"] == "created"]
    assert created_rows and all(c["reverted"] and not c["revertible"] for c in created_rows)
    with pytest.raises(Conflict):
        _revert(users, run, change)
    draft_change = _created_change(users, run, "design.draft")
    with pytest.raises(Conflict):
        _revert(users, run, draft_change)


def test_discard_can_start_from_the_draft_record_and_after_draft_edits(users, workspace):
    run = start(users, workspace)
    created = new_stock(users, run, workspace)
    act(
        users,
        run,
        "r2",
        "draft.update",
        {"draft_id": created["draft_id"], "changes": {"gauge": "22"}},
        expected_state=created["state"],
    )
    change = _created_change(users, run, "design.draft")
    assert change["revertible"]
    _revert(users, run, change)
    assert not Definition.objects.filter(id=created["definition_id"]).exists()


def test_frozen_created_definition_is_not_discarded_and_blockers_are_explained(users, workspace):
    run = start(users, workspace)
    created = new_stock(users, run, workspace)
    op(
        users["editor"],
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    change = _created_change(users, run)
    assert not change["revertible"]
    kinds = {b["model"]: b["kind"] for b in change["revert"]["blockers"]}
    assert kinds["design.revision"] == "frozen"
    with pytest.raises(Conflict, match="frozen revision"):
        _revert(users, run, change)
    assert Definition.objects.filter(id=created["definition_id"]).exists()
    assert package(users, run)["counts"]["reverts"] == 0


def test_referenced_created_definition_is_not_discarded(users, workspace, project):
    run = start(users, workspace)
    created = new_stock(users, run, workspace)
    op(
        users["editor"],
        "project.add_reference",
        {
            "project_id": project,
            "kind": "definition",
            "target_id": created["definition_id"],
            "role": "component",
        },
        expected_state=op(users["editor"], "project.references", {"project_id": project})["state"],
    )
    change = _created_change(users, run)
    assert not change["revertible"]
    assert any(b["model"] == "access.projectreference" for b in change["revert"]["blockers"])
    with pytest.raises(Conflict, match="reference it"):
        _revert(users, run, change)
    assert Definition.objects.filter(id=created["definition_id"]).exists()


def test_management_commands_are_not_operations_and_cannot_be_granted(users, workspace):
    """AGT-005: disposable reset and other deployment/management commands are
    operator-only. They are not in the shared registry, so no run grant can name them."""
    from pathlib import Path

    import specmate
    from specmate.agent_runs.grants import classify
    from specmate.operations import registry

    commands = {
        path.stem
        for path in Path(specmate.__file__).parent.glob("*/management/commands/*.py")
        if path.stem != "__init__"
    }
    assert {"reset_disposable", "backup", "startup", "runner_credential"} <= commands
    names = {spec.name for spec in registry.values()}
    for command in commands:
        for candidate in (command, command.replace("_", "."), f"operations.{command}"):
            assert candidate not in names, candidate
    assert not any("disposable" in name or "reset" in name for name in names)
    for name in ["reset_disposable", "disposable.reset", "operations.reset_disposable", "backup"]:
        assert classify(name) == {
            "operation": name,
            "grantable": False,
            "reason": "unknown_operation",
        }
        for field in ("allowed_actions", "boundary_actions"):
            with pytest.raises(ValidationFailed):
                start(users, workspace, sponsor="owner", **{field: [name]})
    assert not AgentRun.objects.exists()
