import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
from django.db import close_old_connections, connections
from django.test import Client

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

from .conftest import ensure_member, op, remove_member
from .scope_helpers import workspace_of


def part(user, project, kind="board", name="Synthetic board"):
    if kind == "firmware":
        return firmware_part(user, project, name)
    draft = op(
        user,
        "definition.create",
        {"workspace_id": workspace_of(project), "kind": kind, "name": name},
    )
    return draft, op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )


def firmware_part(user, project, name):
    """Typed fixture declarations with simulated PCB evidence; no compiler/native proof."""
    from django.test import override_settings

    from specmate.pcb.pack import recipe_for

    from .test_firmware import board, declaration, sources
    from .test_pcb import intake, source

    actors = {"owner": user, "editor": user}
    original = source.__wrapped__(actors, project)
    preserved = intake.__wrapped__(actors, project, original)
    recipe = recipe_for("board.kicad_pcb", "AGPL-3.0-only")
    with override_settings(SPECMATE_APPROVED_RECIPES={recipe["id"]: recipe}):
        attempt = op(
            user,
            "pcb.request_extraction",
            {
                "intake_id": preserved["intake_id"],
                "recipe_id": recipe["id"],
            },
            idempotency_key="fixture-extract-" + preserved["intake_id"],
        )
    target = board.__wrapped__(actors, project, attempt)
    inputs = sources.__wrapped__(actors, project)
    draft = op(
        user,
        "firmware.create",
        {
            "workspace_id": workspace_of(project),
            "name": name,
            "firmware": declaration(inputs, target),
        },
    )
    frozen = op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    return draft, frozen


def create(user, project, occurrences=(), relationships=(), assignments=()):
    return op(
        user,
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
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
    left_fw_draft, left_fw = part(users["owner"], project, "firmware", "Left firmware")
    right_fw_draft, right_fw = part(users["owner"], project, "firmware", "Right firmware")
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
        left_fw_draft["content"]["firmware"]["target"]["population_revision_id"],
        right_fw_draft["content"]["firmware"]["target"]["population_revision_id"],
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
            {
                "workspace_id": workspace_of(project),
                "name": "Exploded",
                "assembly": {"view_arrangement": {}},
            },
        )


def test_unreadable_nested_closure_returns_no_paths_counts_or_conflict_content(users, project):
    ensure_member(users["outsider"], "editor", project=project)
    _, board = part(users["owner"], project)
    module = create(users["outsider"], project, [occ("private-child", board)])
    module_rev = freeze(users["outsider"], module)
    root = create(users["outsider"], project, [occ("nested", module_rev)])
    root_rev = freeze(users["outsider"], root)
    # Losing workspace membership hides the whole nested closure from every transport.
    remove_member(users["outsider"], project=project)
    for operation, payload in [
        ("assembly.read", {"snapshot_id": root_rev["snapshot_id"]}),
        ("assembly.resolve", {"snapshot_id": root_rev["snapshot_id"], "path": ["no-such-path"]}),
        ("assembly.update", {"draft_id": root["draft_id"], "assembly": {}}),
    ]:
        with pytest.raises(NotFound) as exc:
            op(users["outsider"], operation, payload, expected_state="stale")
        assert exc.value.details == {}
        assert exc.value.message == "Draft not found." or "private-child" not in exc.value.message
    client = Client()
    client.force_login(users["outsider"])
    response = client.get(f"/api/v0/assemblies/snapshots/{root_rev['snapshot_id']}")
    assert response.status_code == 404
    assert response.json()["error"]["details"] == {}
    assert "private-child" not in response.content.decode()


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


def test_replayed_create_rechecks_current_membership(users, project, workspace):
    _, board = part(users["owner"], project)
    payload = {
        "workspace_id": workspace,
        "name": "Synthetic assembly",
        "assembly": {"occurrences": [occ("child", board)]},
    }
    op(users["editor"], "assembly.create", payload, idempotency_key="create-assembly")
    remove_member(users["editor"])
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(users["editor"], "assembly.create", payload, idempotency_key="create-assembly")


def test_foreign_workspace_pin_reads_as_missing_before_any_guard(
    users, project, workspace, other_workspace
):
    # An actor in both workspaces still cannot pin a revision across the boundary.
    ensure_member(users["outsider"], "editor", workspace=workspace)
    remote = op(
        users["outsider"],
        "project.create",
        {"name": "Foreign bench", "workspace_id": other_workspace},
    )["project_id"]
    _, board = part(users["outsider"], remote)
    _, local = part(users["owner"], project)
    before = (Definition.objects.count(), Snapshot.objects.count())
    with pytest.raises(NotFound, match=r"^Not found\.$") as exc:
        op(
            users["outsider"],
            "assembly.create",
            {
                "workspace_id": workspace,
                "name": "Mixed",
                "assembly": {"occurrences": [occ("local", local), occ("foreign", board)]},
            },
        )
    assert exc.value.details == {}
    draft = create(users["outsider"], project, [occ("local", local)])
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(
            users["outsider"],
            "assembly.update",
            {"draft_id": draft["draft_id"], "assembly": {"occurrences": [occ("foreign", board)]}},
            expected_state=draft["state"],
        )
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(
            users["outsider"],
            "draft.update",
            {
                "draft_id": draft["draft_id"],
                "changes": {"assembly": {"occurrences": [occ("foreign", board)]}},
            },
            expected_state=draft["state"],
        )
    # Generic capture with an explicit foreign pin is refused the same way.
    generic = op(
        users["outsider"],
        "definition.create",
        {"workspace_id": workspace, "kind": "note", "name": "Generic"},
    )
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(
            users["outsider"],
            "draft.freeze",
            {"draft_id": generic["draft_id"], "dependencies": [board["revision_id"]]},
            expected_state=generic["state"],
        )
    assert (Definition.objects.count(), Snapshot.objects.count()) == (
        before[0] + 2,
        before[1],
    )


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
            connections.close_all()

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


def test_capture_discovers_closure_replay_and_workspace_namespaces(
    users, project, workspace, other_workspace
):
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
        # Contributors may not freeze (editors hold design.freeze by default).
        op(users["contributor"], "assembly.freeze", payload, expected_state=before)
    # One key is one workspace namespace: creating "in" another project of the same
    # workspace replays the first result instead of creating a second item.
    first = op(
        users["owner"],
        "assembly.create",
        {"workspace_id": workspace, "name": "Reusable"},
        idempotency_key="same-key",
    )
    assert first == op(
        users["owner"],
        "assembly.create",
        {"workspace_id": workspace, "name": "Reusable"},
        idempotency_key="same-key",
    )
    # A second workspace has its own namespace for the same actor and key.
    ensure_member(users["owner"], "contributor", workspace=other_workspace)
    second = op(
        users["owner"],
        "assembly.create",
        {"workspace_id": other_workspace, "name": "Reusable"},
        idempotency_key="same-key",
    )
    assert second["definition_id"] != first["definition_id"]
    assert second["workspace_id"] == other_workspace
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
                "payload": {"workspace_id": workspace_of(project), "name": "API assembly"},
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    result = response.json()["result"]
    assert Draft.objects.get(id=result["draft_id"]).definition.kind == "assembly"
    assert result["content"]["assembly"]["occurrences"] == []
