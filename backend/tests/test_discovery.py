"""AGT-001: discovery is derived from the live registry and the real permission layer."""

import ast
import inspect
import textwrap
import uuid

import pytest
from django.test import Client

from specmate.access.models import Installation, WorkspaceMember
from specmate.builds.models import RunnerCredential
from specmate.builds.operations import RunnerIdentity
from specmate.discovery import requirements
from specmate.operations import (
    Context,
    NotFound,
    OperationSpec,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
    execute,
    registry,
)

from .conftest import op

RECIPE = {
    "id": "synthetic-discovery-r1",
    "image": "example.invalid/test@sha256:" + "2" * 64,
    "argv": ["/tool"],
    "limits": {
        "cpus": 1,
        "memory_bytes": 64 * 1024**2,
        "timeout_seconds": 60,
        "pids": 16,
        "max_output_bytes": 1024,
    },
    "outputs": [{"path": "r.txt", "media_type": "text/plain", "rights": "synthetic-original"}],
}


def discover(user, project_id=None, schemas=False, via="api"):
    payload = {"include_schemas": schemas}
    if project_id is not None:
        payload["project_id"] = project_id
    ctx = Context(user=user, via=via, request_id=f"disc-{uuid.uuid4().hex[:8]}")
    return execute("discovery.capabilities", ctx, payload).result


def by_name(result):
    return {row["operation"]: row for row in result["operations"]}


def test_listing_is_exactly_the_live_registry(users, project):
    result = discover(users["owner"], project, schemas=True)
    rows = by_name(result)
    assert set(rows) == set(registry)
    for name, spec in registry.items():
        assert rows[name]["payload_schema"] == spec.payload.model_json_schema()
        assert rows[name]["requires_expected_state"] == spec.requires_expected_state
        assert rows[name]["supports_idempotency"] == spec.supports_idempotency
    assert "payload_schema" not in by_name(discover(users["owner"], project))["draft.update"]


def test_newly_registered_operation_appears_without_any_list_edit(users, project, monkeypatch):
    from pydantic import BaseModel

    class Empty(BaseModel):
        pass

    spec = OperationSpec(
        "synthetic.future_read",
        "A later module.",
        Empty,
        lambda c, p: {},
        False,
        False,
        (),
        "completed",
        supports_idempotency=False,
    )
    before = discover(users["viewer"], project)["instance"]["registry_sha256"]
    monkeypatch.setitem(registry, "synthetic.future_read", spec)
    result = discover(users["viewer"], project)
    row = by_name(result)["synthetic.future_read"]
    assert row["availability"]["status"] == "available"
    assert row["access"]["basis"] == "rule:fresh-evaluation"
    assert result["instance"]["registry_sha256"] != before


def test_unclassifiable_operation_is_unknown_not_available(users, project, monkeypatch):
    from pydantic import BaseModel

    class Empty(BaseModel):
        pass

    spec = OperationSpec(
        "synthetic.public_thing", "Public.", Empty, lambda c, p: {}, False, True, (), "completed"
    )
    monkeypatch.setitem(registry, "synthetic.public_thing", spec)
    row = by_name(discover(users["owner"], project))["synthetic.public_thing"]
    assert row["availability"] == {"status": "unknown", "reasons": ["requirement_not_declared"]}
    assert row["access"]["kind"] == "undeclared"


@pytest.mark.parametrize(
    ("who", "operation", "status"),
    [
        ("viewer", "inventory.list", "available"),
        ("viewer", "draft.update", "not_permitted"),
        ("editor", "draft.update", "available"),
        ("editor", "draft.freeze", "not_permitted"),
        ("editor", "source.register_blob", "available"),
        ("viewer", "source.register_blob", "not_permitted"),
        ("editor", "inventory.reserve", "not_permitted"),
        ("editor", "project.rename", "not_permitted"),
        ("owner", "project.rename", "available"),
        ("owner", "draft.freeze", "available"),
        ("owner", "inventory.reserve", "available"),
    ],
)
def test_role_matrix_comes_from_the_permission_layer(users, project, who, operation, status):
    row = by_name(discover(users[who], project))[operation]
    assert row["availability"]["status"] == status
    if status == "not_permitted":
        assert row["availability"]["missing"] == row["access"]["minimum_project_permission"]


def test_explicit_grant_changes_the_answer(users, project):
    assert (
        by_name(discover(users["editor"], project))["draft.freeze"]["availability"]["status"]
        == "not_permitted"
    )
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["editor"]).update(
        grants=["design.freeze"]
    )
    result = discover(users["editor"], project)
    assert by_name(result)["draft.freeze"]["availability"]["status"] == "available"
    assert "design.freeze" in result["scope"]["permissions"]


def test_answer_agrees_with_actual_execution(users, project, definition):
    """Not-permitted really is denied; available is not denied by the role check."""
    payload = {"draft_id": definition["draft_id"], "changes": {"z": 1}}
    for who, allowed in (("viewer", False), ("editor", True)):
        status = by_name(discover(users[who], project))["draft.update"]["availability"]["status"]
        assert status == ("available" if allowed else "not_permitted")
        if allowed:
            op(users[who], "draft.update", payload, expected_state="draft-v1")
        else:
            with pytest.raises(PermissionDenied):
                op(users[who], "draft.update", payload, expected_state="draft-v1")
    with pytest.raises(PermissionDenied):
        op(
            users["editor"],
            "draft.freeze",
            {"draft_id": definition["draft_id"]},
            expected_state="draft-v2",
        )


def test_no_project_means_scope_required_and_global_operations_stay_available(users, project):
    result = discover(users["owner"])
    assert result["scope"] is None
    rows = by_name(result)
    assert rows["draft.update"]["availability"]["status"] == "scope_required"
    assert rows["project.create"]["availability"]["status"] == "available"
    assert rows["account.create"]["availability"] == {
        "status": "not_permitted",
        "reasons": ["installation_owner_required"],
    }
    assert rows["session.login"]["availability"]["status"] == "not_applicable"


def test_installation_owner_may_create_accounts(users):
    Installation.objects.update_or_create(singleton=True, defaults={"owner": users["owner"]})
    assert by_name(discover(users["owner"]))["account.create"]["availability"]["status"] == (
        "available"
    )
    assert by_name(discover(users["editor"]))["account.create"]["availability"]["status"] == (
        "not_permitted"
    )


def test_non_user_operations_are_never_offered_to_an_account(users, project):
    rows = by_name(discover(users["owner"], project))
    for name in ("runner.lease", "runner.enroll", "runner.revoke", "build.dispatch", "build.poll"):
        assert rows[name]["availability"]["status"] == "not_applicable", name


def test_outsider_and_unknown_project_are_indistinguishable(users, project):
    with pytest.raises(NotFound) as outsider:
        discover(users["outsider"], project)
    with pytest.raises(NotFound) as missing:
        discover(users["owner"], str(uuid.uuid4()))
    assert outsider.value.as_dict() == missing.value.as_dict()
    assert project not in str(outsider.value.as_dict())


def test_other_projects_do_not_leak_into_scope_or_native_state(users, project, settings):
    settings.SPECMATE_APPROVED_RECIPES = {RECIPE["id"]: RECIPE}
    other = op(users["editor"], "project.create", {"name": "Other synthetic bench"})["project_id"]
    Installation.objects.update_or_create(singleton=True, defaults={"owner": users["owner"]})
    RunnerCredential.objects.create(
        name="runner",
        project_id=project,
        recipe_ids=[RECIPE["id"]],
        token_sha256="a" * 64,
        expires_at="2999-01-01T00:00:00Z",
        created_by=users["owner"],
    )
    own = discover(users["editor"], other)
    assert own["scope"]["project_id"] == other and own["scope"]["role"] == "owner"
    assert own["capabilities"]["native_execution"]["status"] == "degraded"
    shared = discover(users["owner"], project)
    assert shared["capabilities"]["native_execution"]["status"] == "available"
    dumped = str(own)
    assert project not in dumped


def test_native_execution_reports_unavailable_degraded_and_available(users, project, settings):
    settings.SPECMATE_APPROVED_RECIPES = {}
    result = discover(users["owner"], project)
    assert result["capabilities"]["native_execution"] == {
        "status": "unavailable",
        "reasons": ["no_approved_recipe"],
        "approved_recipes": 0,
    }
    native = {n for n, s in registry.items() if "recipe_id" in s.payload.model_fields}
    assert {
        "build.request",
        "pcb.request_extraction",
        "firmware_build.request",
        "pcb_fabrication.request",
        "pcb_disagreement.request_native",
    } <= native
    rows = by_name(result)
    for name in native:
        if rows[name]["access"]["kind"] == "project":
            assert rows[name]["availability"]["status"] == "unavailable", name
            assert rows[name]["availability"]["reasons"] == ["no_approved_recipe"]
    assert rows["draft.update"]["availability"]["status"] == "available"

    settings.SPECMATE_APPROVED_RECIPES = {RECIPE["id"]: RECIPE}
    degraded = discover(users["owner"], project)
    assert by_name(degraded)["build.request"]["availability"] == {
        "status": "degraded",
        "reasons": ["no_active_runner_for_project"],
    }
    assert degraded["capabilities"]["native_execution"]["approved_recipe_ids"] == [RECIPE["id"]]

    RunnerCredential.objects.create(
        name="runner",
        project_id=project,
        recipe_ids=[RECIPE["id"]],
        token_sha256="b" * 64,
        expires_at="2999-01-01T00:00:00Z",
        created_by=users["owner"],
    )
    assert (
        by_name(discover(users["owner"], project))["build.request"]["availability"]["status"]
        == "available"
    )
    RunnerCredential.objects.update(revoked_at="2026-01-01T00:00:00Z")
    assert discover(users["owner"], project)["capabilities"]["native_execution"]["status"] == (
        "degraded"
    )


def test_recipe_identifiers_are_hidden_from_actors_without_execution_authority(
    users, project, settings
):
    settings.SPECMATE_APPROVED_RECIPES = {RECIPE["id"]: RECIPE}
    viewer = discover(users["viewer"], project)
    assert "approved_recipe_ids" not in viewer["capabilities"]["native_execution"]
    assert RECIPE["id"] not in str(viewer)
    assert by_name(viewer)["build.request"]["availability"]["status"] == "not_permitted"


def test_transports_do_not_claim_an_mcp_adapter_that_does_not_exist(users, project):
    transports = discover(users["owner"], project)["transports"]
    assert transports["http_api"]["status"] == "available"
    assert transports["mcp"] == {
        "status": "unavailable",
        "reason": "no_mcp_adapter_in_this_instance",
    }


def test_unauthenticated_inactive_and_runner_actors_are_rejected(users, project):
    ctx = Context(user=None, via="api", request_id="anon")
    with pytest.raises(Unauthenticated):
        execute("discovery.capabilities", ctx, {})
    users["viewer"].is_active = False
    users["viewer"].save()
    with pytest.raises(Unauthenticated):
        discover(users["viewer"], project)
    runner = Context(user=RunnerIdentity(uuid.uuid4()), via="api", request_id="r")
    with pytest.raises(PermissionDenied):
        execute("discovery.capabilities", runner, {})


def test_invalid_payload_and_idempotency_key_are_rejected(users, project):
    with pytest.raises(ValidationFailed):
        execute(
            "discovery.capabilities",
            Context(user=users["owner"], via="api", request_id="x"),
            {"project_id": "not-a-uuid"},
        )
    with pytest.raises(ValidationFailed):
        execute(
            "discovery.capabilities",
            Context(user=users["owner"], via="api", request_id="x", idempotency_key="k"),
            {},
        )
    with pytest.raises(ValidationFailed):
        execute(
            "discovery.capabilities",
            Context(user=users["owner"], via="api", request_id="x"),
            {"project_id": project, "extra": 1},
        )


def test_membership_change_is_visible_immediately(users, project):
    assert discover(users["viewer"], project)["scope"]["role"] == "viewer"
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["viewer"]).delete()
    with pytest.raises(NotFound):
        discover(users["viewer"], project)


def test_http_adapter_uses_the_shared_operation(users, project):
    client = Client()
    assert client.get("/api/v0/discovery/capabilities").status_code == 401
    client.force_login(users["editor"])
    response = client.get(
        f"/api/v0/discovery/capabilities?project_id={project}&include_schemas=true"
    )
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["scope"]["role"] == "editor"
    assert by_name(body)["draft.update"]["availability"]["status"] == "available"
    assert "payload_schema" in by_name(body)["draft.update"]
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/discovery/capabilities?project_id={project}").status_code == 404


def test_declared_requirements_agree_with_handler_permission_references():
    """Cross-check the classification against Perm references inside each handler."""
    reviewed_exceptions = {"catalog.register_lot"}  # needs design.edit via editable_revision()
    problems = []
    for name, spec in registry.items():
        found = requirements.requirement_for(
            name, supports_idempotency=spec.supports_idempotency, public=spec.public
        )
        if found is None or found[0].permission is None or name in reviewed_exceptions:
            continue
        tree = ast.parse(textwrap.dedent(inspect.getsource(spec.handler)))
        refs = {
            n.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Attribute)
            and isinstance(n.value, ast.Name)
            and n.value.id == "Perm"
            and n.attr.isupper()
        }
        if refs and found[0].permission.name not in refs:
            problems.append((name, found[0].permission.name, sorted(refs)))
    assert not problems
