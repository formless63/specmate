import copy
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
from django.db import close_old_connections, connections
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.design.models import Definition, Snapshot
from specmate.interfaces.queries import inspect_revision, trace, validate_content
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import ensure_member, op

BODY = {
    "kind": "connector_body",
    "contacts": [
        {"contact_id": "a"},
        {"contact_id": "b"},
        {"contact_id": "shell", "physical_role": "shell"},
        {"contact_id": "key", "physical_role": "key"},
    ],
}


def create(user, project, interface=BODY, **ctx):
    return op(
        user,
        "interface.create",
        {"project_id": project, "name": "Synthetic interface", "interface": interface},
        **ctx,
    )


def freeze(user, draft, **ctx):
    return op(
        user,
        "interface.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def pinout(body, signal="sense"):
    return {
        "kind": "pinout",
        "body_revision_id": body["revision_id"],
        "review": "reviewed",
        "review_basis": "Synthetic independent pin table",
        "assignments": [{"contact_id": "a", "electrical": {"signal": signal}}],
    }


def setup_mapping(user, project, internal_kind="board"):
    body = freeze(user, create(user, project))
    pins = freeze(user, create(user, project, pinout(body)))
    if internal_kind == "connector_body":
        board = body
    else:
        board_draft = op(
            user,
            "definition.create",
            {"project_id": project, "name": "Synthetic board", "kind": "board"},
        )
        board = op(
            user,
            "draft.freeze",
            {"draft_id": board_draft["draft_id"]},
            expected_state=board_draft["state"],
        )
    assembly_draft = op(
        user,
        "assembly.create",
        {
            "project_id": project,
            "name": "Repeated boards",
            "assembly": {
                "occurrences": [
                    {"local_id": side, "revision_id": board["revision_id"], "display_ref": "B1"}
                    for side in ("left", "right")
                ]
            },
        },
    )
    assembly = op(
        user,
        "assembly.freeze",
        {"draft_id": assembly_draft["draft_id"]},
        expected_state=assembly_draft["state"],
    )
    mapping = {
        "kind": "interface_map",
        "assembly_revision_id": assembly["revision_id"],
        "external_pinout_revision_id": pins["revision_id"],
        "passages": [
            {
                "local_id": "declared-path",
                "external_contact_id": "a",
                "basis": "Declared drawing",
                "internal": {
                    "path": ["right"],
                    "revision_id": board["revision_id"],
                    "feature_id": "a" if internal_kind == "connector_body" else "header.pin3",
                },
            }
        ],
    }
    return body, pins, board, assembly, mapping


def test_shared_body_two_reviewed_pinouts_keep_roles_and_unknowns(users, project):
    user = users["owner"]
    draft = create(user, project)
    body = freeze(user, draft)
    versions = [
        freeze(user, create(user, project, pinout(body, signal))) for signal in ("sense", "power")
    ]
    views = [inspect_revision(user, version["revision_id"]) for version in versions]
    assert views[0]["interface"]["body_revision_id"] == views[1]["interface"]["body_revision_id"]
    assert [view["contacts"][0]["electrical"]["signal"] for view in views] == ["sense", "power"]
    assert all(view["compatibility"] == "not_evaluated" for view in views)
    assert views[0]["contacts"][1]["electrical"] is None
    assert views[0]["contacts"][0]["electrical"]["voltage_max_v"] is None
    assert views[0]["interface"]["orientation"]["viewing_side"] == "unknown"
    snapshot = Snapshot.objects.get(id=versions[0]["snapshot_id"])
    assert set(snapshot.dependencies.values_list("revision_id", flat=True)) == {
        UUID(body["revision_id"])
    }
    before = bytes(snapshot.canonical)
    op(
        user,
        "interface.update",
        {"draft_id": draft["draft_id"], "interface": {**BODY, "family": "Later body label"}},
        expected_state=body["draft"]["state"],
    )
    assert bytes(Snapshot.objects.get(id=snapshot.id).canonical) == before


@pytest.mark.parametrize(
    "internal_kind,feature_status",
    [("board", "not_evaluated"), ("connector_body", "declared_contact")],
)
def test_declared_trace_preserves_exact_board_occurrence(
    users, project, internal_kind, feature_status
):
    user = users["owner"]
    body, pins, board, assembly, mapping = setup_mapping(user, project, internal_kind)
    frozen = freeze(user, create(user, project, mapping))
    result = trace(user, frozen["revision_id"], "a")
    assert result["status"] == "declared"
    assert result["continuity"] == result["compatibility"] == "not_evaluated"
    assert result["targets"][0] == {
        "passage_id": "declared-path",
        "assembly_revision_id": assembly["revision_id"],
        "snapshot_id": assembly["snapshot_id"],
        "path": ["right"],
        "revision_id": board["revision_id"],
        "feature_id": mapping["passages"][0]["internal"]["feature_id"],
        "condition": None,
        "basis": "Declared drawing",
        "feature_status": feature_status,
    }
    assert trace(user, frozen["revision_id"], "b")["status"] == "unknown"
    pins_saved = set(
        Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    )
    assert pins_saved == {UUID(row["revision_id"]) for row in (body, pins, board, assembly)}


@pytest.mark.parametrize("field,value", [("path", ["missing"]), ("feature_id", "missing")])
def test_known_internal_feature_and_occurrence_must_resolve(users, project, field, value):
    *_, mapping = setup_mapping(users["owner"], project, "connector_body")
    mapping["passages"][0]["internal"][field] = value
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, mapping)
    assert Definition.objects.count() == before


def test_wrong_internal_revision_and_external_contact_rejected(users, project):
    _, pins, _, _, mapping = setup_mapping(users["owner"], project)
    invalid = copy.deepcopy(mapping)
    invalid["passages"][0]["internal"]["revision_id"] = pins["revision_id"]
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, invalid)
    mapping["passages"][0]["external_contact_id"] = "key"
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, mapping)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(review_basis=None),
        lambda p: p["assignments"].append(p["assignments"][0]),
        lambda p: p["assignments"][0].update(contact_id="absent"),
        lambda p: p["assignments"][0].update(contact_id="key"),
        lambda p: p["assignments"][0]["electrical"].update(voltage_min_v=5, voltage_max_v=2),
        lambda p: p["assignments"][0]["electrical"].update(current_max_a=-1),
        lambda p: p["assignments"][0]["electrical"].update(compatible=True),
        lambda p: p.update(
            orientation={"viewing_side": "unknown", "rotation_degrees": 0, "datum": "top"}
        ),
        lambda p: p.update(orientation={"viewing_side": "mating", "rotation_degrees": 0}),
    ],
)
def test_strict_invalid_pinouts(users, project, mutate):
    body = freeze(users["owner"], create(users["owner"], project))
    p = pinout(body)
    mutate(p)
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, p)


def test_kind_and_required_contract_hooks():
    with pytest.raises(ValidationFailed):
        validate_content("pinout", {"interface": BODY})
    with pytest.raises(ValidationFailed):
        validate_content("connector_body", {})
    assert validate_content("board", {}) == {}


@pytest.mark.parametrize("actor,exception", [("viewer", PermissionDenied), ("outsider", NotFound)])
def test_mutation_scope_and_read_visibility(users, project, actor, exception):
    draft = create(users["owner"], project)
    body = freeze(users["owner"], draft)
    with pytest.raises(exception):
        create(users[actor], project)
    with pytest.raises(exception):
        op(
            users[actor],
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": BODY},
            expected_state=body["draft"]["state"],
        )
    if actor == "viewer":
        assert (
            inspect_revision(users[actor], body["revision_id"])["interface"]["kind"]
            == "connector_body"
        )
    else:
        with pytest.raises(NotFound):
            inspect_revision(users[actor], body["revision_id"])


def test_current_dependency_scope_on_replay_and_read(users, project):
    user = users["editor"]
    WorkspaceMember.objects.filter(user=user, workspace__projects=project).update(
        grants=["design.freeze"]
    )
    private = op(users["owner"], "project.create", {"name": "Restricted body"})["project_id"]
    membership = ensure_member(user, "viewer", project=private)
    body = freeze(users["owner"], create(users["owner"], private))
    p = pinout(body)
    draft = create(user, project, p, idempotency_key="pinout-key")
    frozen = freeze(user, draft, idempotency_key="freeze-key")
    membership.delete()
    with pytest.raises(NotFound):
        create(user, project, p, idempotency_key="pinout-key")
    with pytest.raises(NotFound):
        freeze(user, draft, idempotency_key="freeze-key")
    with pytest.raises(NotFound):
        inspect_revision(user, frozen["revision_id"])
    with pytest.raises(NotFound):
        op(
            user,
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": p},
            expected_state="stale",
        )


def test_key_namespaces_replay_and_stale_write(users, project):
    user = users["owner"]
    other = op(user, "project.create", {"name": "Other"})["project_id"]
    a = create(user, project, idempotency_key="key")
    b = create(user, other, idempotency_key="key")
    assert a["definition_id"] != b["definition_id"]
    assert create(user, project, idempotency_key="key") == a
    with pytest.raises(IdempotencyMismatch):
        create(user, project, {**BODY, "family": "Changed"}, idempotency_key="key")
    frozen = freeze(user, a, idempotency_key="freeze-key")
    assert freeze(user, a, idempotency_key="freeze-key") == frozen
    with pytest.raises(Conflict):
        op(
            user,
            "interface.update",
            {"draft_id": a["draft_id"], "interface": BODY},
            expected_state=a["state"],
        )


def test_http_and_jobs_use_same_mutation_and_trace(users, project):
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "interface.create",
                "request_id": "interface-api",
                "payload": {
                    "project_id": project,
                    "name": "Synthetic HTTP body",
                    "interface": BODY,
                },
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    draft = response.json()["result"]
    frozen = freeze(users["owner"], draft)
    assert client.get(f"/api/v0/interfaces/revisions/{frozen['revision_id']}").status_code == 200
    assert client.get(f"/api/v0/interfaces/drafts/{draft['draft_id']}").status_code == 200
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/interfaces/revisions/{frozen['revision_id']}").status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_interface_updates_have_one_winner(users, project):
    draft = create(users["owner"], project)
    barrier = Barrier(2)

    def write(family):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            op(
                users["owner"],
                "interface.update",
                {"draft_id": draft["draft_id"], "interface": {**BODY, "family": family}},
                expected_state=draft["state"],
            )
            return "saved"
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, ["Alpha", "Beta"]))
    assert sorted(results) == ["conflict", "saved"]


def test_api_trace_uses_query_parameter_for_arbitrary_contact_ids(users, project):
    *_, mapping = setup_mapping(users["owner"], project)
    frozen = freeze(users["owner"], create(users["owner"], project, mapping))
    client = Client()
    client.force_login(users["owner"])
    response = client.get(
        f"/api/v0/interfaces/revisions/{frozen['revision_id']}/trace", {"contact_id": "a"}
    )
    assert response.status_code == 200
    assert response.json()["targets"][0]["path"] == ["right"]
    assert (
        client.get(
            f"/api/v0/interfaces/revisions/{frozen['revision_id']}/trace",
            {"contact_id": "absent/contact"},
        ).status_code
        == 404
    )


@pytest.mark.django_db(transaction=True)
def test_competing_keyed_creates_have_one_effect(users, project):
    barrier = Barrier(2)

    def create_once(_):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            return create(users["owner"], project, idempotency_key="concurrent-key")
        except Conflict:
            # The shared operation contract rolls back the losing transaction.
            return create(users["owner"], project, idempotency_key="concurrent-key")
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create_once, range(2)))
    assert results[0] == results[1]
    assert Definition.objects.filter(kind="connector_body").count() == 1


def test_current_freeze_grant_rechecked_on_retained_replay(users, project):
    WorkspaceMember.objects.filter(user=users["editor"], workspace__projects=project).update(
        grants=["design.freeze"]
    )
    draft = create(users["editor"], project)
    freeze(users["editor"], draft, idempotency_key="granted-freeze")
    WorkspaceMember.objects.filter(user=users["editor"], workspace__projects=project).update(
        grants=[]
    )
    with pytest.raises(PermissionDenied):
        freeze(users["editor"], draft, idempotency_key="granted-freeze")


@pytest.mark.parametrize("kind", ["connector_body", "pinout", "interface_map"])
def test_incomplete_interface_reads_keep_kind_but_cannot_capture(users, project, kind):
    user = users["owner"]
    draft = op(
        user,
        "definition.create",
        {
            "project_id": project,
            "name": "Unfinished interface",
            "kind": kind,
        },
    )
    client = Client()
    client.force_login(user)
    response = client.get(f"/api/v0/interfaces/drafts/{draft['draft_id']}")
    assert response.status_code == 200
    assert response.json()["kind"] == kind
    assert response.json()["content"] == {}
    for operation in ("interface.snapshot", "interface.freeze"):
        with pytest.raises(ValidationFailed):
            op(user, operation, {"draft_id": draft["draft_id"]}, expected_state=draft["state"])
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/interfaces/drafts/{draft['draft_id']}").status_code == 404


def test_incomplete_pinout_can_resume_through_typed_update_and_freeze(users, project):
    user = users["owner"]
    body = freeze(user, create(user, project))
    draft = op(
        user,
        "definition.create",
        {
            "project_id": project,
            "name": "Unfinished pinout",
            "kind": "pinout",
        },
    )
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "interface.update",
            {"draft_id": draft["draft_id"], "interface": pinout(body)},
            expected_state=draft["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            user,
            "interface.update",
            {
                "draft_id": draft["draft_id"],
                "interface": {"kind": "pinout", "body_revision_id": ""},
            },
            expected_state=draft["state"],
        )
    updated = op(
        user,
        "interface.update",
        {"draft_id": draft["draft_id"], "interface": pinout(body)},
        expected_state=draft["state"],
    )
    frozen = freeze(user, updated)
    assert (
        inspect_revision(user, frozen["revision_id"])["interface"]["body_revision_id"]
        == body["revision_id"]
    )
