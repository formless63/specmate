import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
from django.db import close_old_connections
from django.test import Client

from specmate.access.models import Membership
from specmate.assemblies.queries import (
    permitted_self_dependencies,
    read_assembly,
    resolve_occurrence,
)
from specmate.design.models import Definition, Draft, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord

from .conftest import op


def part(user, project, kind="board", name="Synthetic board"):
    draft = op(user, "definition.create", {"project_id": project, "kind": kind, "name": name})
    return draft, op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


def create(user, project, occurrences=(), relationships=(), assignments=()):
    return op(
        user,
        "assembly.create",
        {
            "project_id": project,
            "name": "Synthetic assembly",
            "assembly": {
                "occurrences": list(occurrences),
                "relationships": list(relationships),
                "assignments": list(assignments),
            },
        },
    )


def freeze(user, draft):
    return op(
        user,
        "assembly.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )


def occ(local_id, revision, display_ref="J1", **extra):
    return {
        "local_id": local_id,
        "revision_id": revision["revision_id"],
        "display_ref": display_ref,
        **extra,
    }


def endpoint(path, feature_id=None):
    return {"kind": "occurrence", "path": path, "feature_id": feature_id}


def test_repeated_nested_boards_keep_distinct_addresses_assignments_and_exact_pins(users, project):
    board_draft, board = part(users["owner"], project)
    _, left_fw = part(users["owner"], project, "firmware", "Left firmware")
    _, right_fw = part(users["owner"], project, "firmware", "Right firmware")
    module = create(users["owner"], project, [occ("control-board", board)])
    module_revision = freeze(users["owner"], module)
    root = create(
        users["owner"],
        project,
        [
            occ("left-module", module_revision, "Module"),
            occ("right-module", module_revision, "Module"),
        ],
        assignments=[
            {
                "path": ["left-module", "control-board"],
                "assignments": {"firmware_revision_id": left_fw["revision_id"]},
            },
            {
                "path": ["right-module", "control-board"],
                "assignments": {"firmware_revision_id": right_fw["revision_id"]},
            },
        ],
    )
    frozen = freeze(users["owner"], root)
    snapshot_id = frozen["snapshot_id"]
    before = bytes(Snapshot.objects.get(id=snapshot_id).canonical)
    left = resolve_occurrence(
        users["owner"], snapshot_id, ["left-module", "control-board"], "connector-a.pin2"
    )
    right = resolve_occurrence(
        users["owner"], snapshot_id, ["right-module", "control-board"], "connector-a.pin2"
    )
    assert left["display_ref"] == right["display_ref"] == "J1"
    assert left["revision_id"] == right["revision_id"] == board["revision_id"]
    assert left["address"] != right["address"]
    assert left["assignments"]["firmware_revision_id"] == left_fw["revision_id"]
    assert right["assignments"]["firmware_revision_id"] == right_fw["revision_id"]
    assert right["feature_status"] == "not_evaluated"
    op(
        users["owner"],
        "draft.update",
        {"draft_id": board_draft["draft_id"], "changes": {"later": True}},
        expected_state=board["draft"]["state"],
    )
    newer = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": board_draft["draft_id"]},
        expected_state="draft-v3",
    )
    assert newer["revision_id"] != board["revision_id"]
    assert bytes(Snapshot.objects.get(id=snapshot_id).canonical) == before
    assert (
        resolve_occurrence(users["owner"], snapshot_id, ["right-module", "control-board"])[
            "revision_id"
        ]
        == board["revision_id"]
    )
    pins = {entry["revision_id"] for entry in json.loads(before)["dependencies"]}
    assert pins == {
        board["revision_id"],
        module_revision["revision_id"],
        left_fw["revision_id"],
        right_fw["revision_id"],
    }


def test_containment_cycle_rejected_documentary_and_electrical_cycles_allowed(users, project):
    _, board = part(users["owner"], project)
    occurrences = [occ("a", board), occ("b", board)]
    relationships = [
        {
            "kind": "documentation",
            "local_id": "doc-a",
            "subject": endpoint(["a"]),
            "document": endpoint(["b"]),
        },
        {
            "kind": "documentation",
            "local_id": "doc-b",
            "subject": endpoint(["b"]),
            "document": endpoint(["a"]),
        },
        {
            "kind": "electrical",
            "local_id": "wire-a",
            "a": endpoint(["a"], "port.pin1"),
            "b": endpoint(["b"], "port.pin1"),
        },
        {
            "kind": "electrical",
            "local_id": "wire-b",
            "b": endpoint(["a"], "port.pin2"),
            "a": endpoint(["b"], "port.pin2"),
        },
        {"kind": "mating", "local_id": "mate", "a": endpoint(["a"]), "b": endpoint(["b"])},
        {
            "kind": "mounting",
            "local_id": "mount",
            "mounted": endpoint(["a"]),
            "support": endpoint(["b"]),
        },
        {
            "kind": "source_derivation",
            "local_id": "source",
            "subject": endpoint(["a"]),
            "source": {"kind": "revision", "revision_id": board["revision_id"]},
        },
        {
            "kind": "procurement",
            "local_id": "order",
            "subject": endpoint(["a"]),
            "orderable": {"kind": "revision", "revision_id": board["revision_id"]},
        },
    ]
    created = create(users["owner"], project, occurrences, relationships)
    frozen = freeze(users["owner"], created)
    assert len(read_assembly(users["owner"], frozen["snapshot_id"])["relationships"]) == 8
    cycle = [
        {
            "kind": "containment",
            "local_id": "contains-a",
            "parent": endpoint(["a"]),
            "child": endpoint(["b"]),
        },
        {
            "kind": "containment",
            "local_id": "contains-b",
            "parent": endpoint(["b"]),
            "child": endpoint(["a"]),
        },
    ]
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed, match="Containment cycle"):
        create(users["owner"], project, occurrences, cycle)
    assert Definition.objects.count() == before
    # Structural root->a edges also prevent making the root a child of a.
    with pytest.raises(ValidationFailed, match="Containment cycle"):
        create(
            users["owner"],
            project,
            occurrences,
            [
                {
                    "kind": "containment",
                    "local_id": "back",
                    "parent": endpoint(["a"]),
                    "child": endpoint([]),
                }
            ],
        )


def test_canonical_placement_unknowns_and_view_arrangements_are_separate(users, project):
    _, board = part(users["owner"], project)
    placement = {"status": "known", "translation": [10, 20, 30], "rotation_xyzw": [0, 0, 0, 1]}
    created = create(users["owner"], project, [occ("a", board, placement=placement)])
    frozen = freeze(users["owner"], created)
    node = read_assembly(users["owner"], frozen["snapshot_id"])["occurrences"][0]
    assert node["placement"]["translation"] == [10, 20, 30]
    assert node["placement"]["unit"] == "mm"
    for invalid in (
        {"status": "unknown", "translation": [0, 0, 0]},
        {"status": "known", "translation": [0, 0, 0], "rotation_xyzw": [0, 0, 0, 0]},
        {"status": "known", "translation": [0, 0, float("inf")], "rotation_xyzw": [0, 0, 0, 1]},
    ):
        with pytest.raises(ValidationFailed):
            create(users["owner"], project, [occ("b", board, placement=invalid)])
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "assembly.create",
            {"project_id": project, "name": "Exploded", "assembly": {"view_arrangement": {}}},
        )


def test_unreadable_nested_closure_returns_no_paths_counts_or_conflict_content(users, project):
    remote = op(users["outsider"], "project.create", {"name": "Restricted project"})["project_id"]
    Membership.objects.create(project_id=remote, user=users["owner"], role="viewer")
    _, board = part(users["outsider"], remote)
    module = create(users["owner"], project, [occ("private-child", board)])
    module_rev = freeze(users["owner"], module)
    root = create(users["owner"], project, [occ("nested", module_rev)])
    root_rev = freeze(users["owner"], root)
    Membership.objects.filter(project_id=remote, user=users["owner"]).delete()
    for operation, payload in [
        ("assembly.read", {"snapshot_id": root_rev["snapshot_id"]}),
        ("assembly.resolve", {"snapshot_id": root_rev["snapshot_id"], "path": ["no-such-path"]}),
        ("assembly.update", {"draft_id": root["draft_id"], "assembly": {}}),
    ]:
        with pytest.raises(NotFound) as exc:
            op(users["owner"], operation, payload, expected_state="stale")
        assert exc.value.details == {}
        assert "private-child" not in exc.value.message
    client = Client()
    client.force_login(users["owner"])
    response = client.get(f"/api/v0/assemblies/snapshots/{root_rev['snapshot_id']}")
    assert response.status_code == 404
    assert response.json()["error"]["details"] == {}


def test_shared_operations_stale_replay_mismatch_permissions_and_rollback(users, project):
    created = create(users["owner"], project)
    payload = {"draft_id": created["draft_id"], "assembly": {}}
    first = op(
        users["owner"],
        "assembly.update",
        payload,
        expected_state="draft-v1",
        idempotency_key="edit-assembly",
    )
    assert (
        op(
            users["owner"],
            "assembly.update",
            payload,
            expected_state="draft-v1",
            idempotency_key="edit-assembly",
        )
        == first
    )
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "assembly.update",
            {
                **payload,
                "assembly": {
                    "occurrences": [{"local_id": "missing", "revision_id": str(UUID(int=0))}]
                },
            },
            expected_state="draft-v1",
            idempotency_key="edit-assembly",
        )
    with pytest.raises(Conflict):
        op(users["editor"], "assembly.update", payload, expected_state="draft-v1")
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "assembly.update", payload, expected_state="draft-v2")
    with pytest.raises(NotFound):
        op(users["outsider"], "assembly.update", payload, expected_state="draft-v2")
    records = IdempotencyRecord.objects.count()
    with pytest.raises(NotFound):
        create(users["owner"], project, [{"local_id": "a", "revision_id": str(UUID(int=0))}])
    assert IdempotencyRecord.objects.count() == records
    assert Draft.objects.get(id=created["draft_id"]).state_token == "draft-v2"


def test_replayed_create_rechecks_child_access(users, project):
    remote = op(users["outsider"], "project.create", {"name": "Restricted project"})["project_id"]
    Membership.objects.create(project_id=remote, user=users["owner"], role="viewer")
    _, board = part(users["outsider"], remote)
    payload = {
        "project_id": project,
        "name": "Synthetic assembly",
        "assembly": {"occurrences": [occ("child", board)]},
    }
    op(users["owner"], "assembly.create", payload, idempotency_key="create-assembly")
    Membership.objects.filter(project_id=remote, user=users["owner"]).delete()
    with pytest.raises(NotFound):
        op(users["owner"], "assembly.create", payload, idempotency_key="create-assembly")


@pytest.mark.django_db(transaction=True)
def test_competing_assembly_edits_have_one_winner(users, project):
    created = create(users["owner"], project)
    barrier = Barrier(2)

    def edit():
        close_old_connections()
        barrier.wait(timeout=10)
        try:
            op(
                users["owner"],
                "assembly.update",
                {"draft_id": created["draft_id"], "assembly": {}},
                expected_state="draft-v1",
            )
            return "updated"
        except Conflict:
            return "conflict"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: edit(), range(2)))
    assert sorted(results) == ["conflict", "updated"]
    assert Draft.objects.get(id=created["draft_id"]).state_token == "draft-v2"


def test_api_and_job_read_same_projection_and_read_does_not_cache(users, project):
    created = create(users["owner"], project)
    frozen = freeze(users["owner"], created)
    payload = {"snapshot_id": frozen["snapshot_id"]}
    expected = op(users["viewer"], "assembly.read", payload)
    client = Client()
    client.force_login(users["viewer"])
    response = client.get(f"/api/v0/assemblies/snapshots/{frozen['snapshot_id']}")
    assert response.status_code == 200 and response.json() == expected
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "assembly.read", payload, idempotency_key="never-cache-reads")


def test_capture_discovers_closure_replay_and_project_namespaces(users, project):
    _, board = part(users["owner"], project)
    draft = create(users["owner"], project, [occ("a", board)])
    payload = {"draft_id": draft["draft_id"]}
    before = Draft.objects.get(id=draft["draft_id"]).state_token
    captured = op(
        users["editor"],
        "assembly.snapshot",
        payload,
        expected_state=before,
        idempotency_key="capture",
    )
    assert Draft.objects.get(id=draft["draft_id"]).state_token == before
    assert captured == op(
        users["editor"],
        "assembly.snapshot",
        payload,
        expected_state=before,
        idempotency_key="capture",
    )
    assert json.loads(bytes(Snapshot.objects.get(id=captured["snapshot_id"]).canonical))[
        "dependencies"
    ] == [{"revision_id": board["revision_id"], "sha256": board["sha256"]}]
    frozen = op(
        users["owner"], "assembly.freeze", payload, expected_state=before, idempotency_key="freeze"
    )
    assert frozen == op(
        users["owner"], "assembly.freeze", payload, expected_state=before, idempotency_key="freeze"
    )
    with pytest.raises(PermissionDenied):
        op(users["editor"], "assembly.freeze", payload, expected_state=before)
    remote = op(users["owner"], "project.create", {"name": "Other synthetic project"})["project_id"]
    for project_id in (project, remote):
        op(
            users["owner"],
            "assembly.create",
            {"project_id": project_id, "name": "Reusable"},
            idempotency_key="same-key",
        )
    assert (
        IdempotencyRecord.objects.filter(operation="assembly.create", key="same-key").count() == 2
    )


def test_invalid_paths_duplicate_ids_and_revision_owned_overrides_are_rejected(users, project):
    _, board = part(users["owner"], project)
    for occurrences in (
        [occ("a", board), occ("a", board)],
        [occ("a", board, assignments={"pin_map": {"1": "2"}})],
    ):
        with pytest.raises(ValidationFailed):
            create(users["owner"], project, occurrences)
    with pytest.raises(ValidationFailed, match="does not resolve"):
        create(
            users["owner"],
            project,
            [occ("a", board)],
            [
                {
                    "kind": "mating",
                    "local_id": "missing",
                    "a": endpoint(["a"]),
                    "b": endpoint(["missing"]),
                }
            ],
        )
    with pytest.raises(ValidationFailed, match="firmware revision"):
        create(
            users["owner"],
            project,
            [occ("a", board, assignments={"firmware_revision_id": board["revision_id"]})],
        )


def test_definition_equality_is_not_an_actual_resolved_containment_cycle(users, project):
    initial = create(users["owner"], project)
    revision = freeze(users["owner"], initial)
    definition = Definition.objects.get(id=initial["definition_id"])
    documented = {
        "assembly": {
            "relationships": [
                {
                    "kind": "documentation",
                    "local_id": "prior-design",
                    "subject": endpoint([]),
                    "document": {"kind": "revision", "revision_id": revision["revision_id"]},
                }
            ]
        }
    }
    reused = {"assembly": {"occurrences": [occ("prior-finite-assembly", revision)]}}
    for content in (documented, reused):
        assert permitted_self_dependencies(users["owner"], definition, content) == {
            UUID(revision["revision_id"])
        }
    assert permitted_self_dependencies(users["owner"], definition, {"assembly": {}}) == set()


def test_long_containment_chain_is_iterative_and_cycles_remain_rejected(users, project):
    _, board = part(users["owner"], project)
    occurrences = [occ(f"item-{index}", board) for index in range(1000)]
    edges = [
        {
            "kind": "containment",
            "local_id": f"contains-{index}",
            "parent": endpoint([f"item-{index}"]),
            "child": endpoint([f"item-{index + 1}"]),
        }
        for index in range(999)
    ]
    assert create(users["owner"], project, occurrences, edges)["state"] == "draft-v1"
    edges.append(
        {
            "kind": "containment",
            "local_id": "back",
            "parent": endpoint(["item-999"]),
            "child": endpoint(["item-0"]),
        }
    )
    with pytest.raises(ValidationFailed, match="Containment cycle"):
        create(users["owner"], project, occurrences, edges)


def test_api_mutation_uses_same_shared_operation(users, project):
    client = Client()
    client.force_login(users["editor"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "assembly.create",
                "request_id": "assembly-api",
                "idempotency_key": "api-create",
                "payload": {"project_id": project, "name": "API assembly"},
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    result = response.json()["result"]
    assert Draft.objects.get(id=result["draft_id"]).definition.kind == "assembly"
    assert result["content"]["assembly"]["occurrences"] == []
