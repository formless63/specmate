"""ACC-FW-002: synthetic declarations, simulated PCB report acceptance, no compiler.

Real PostgreSQL verifies contextual identity, immutable evidence and shared operations.
"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import IntegrityError, close_old_connections, connections, transaction

from specmate.design.models import Draft, Revision, SnapshotDependency
from specmate.firmware_occurrences.models import FirmwareAdoption
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord

from .conftest import op, remove_member, set_role
from .scope_helpers import workspace_of
from .test_firmware import (  # noqa: F401
    CONFIG,
    MAIN,
    attempt,
    board,
    declaration,
    digest,
    intake,
    recipe,
    source,
    sources,
)
from .test_transports import api, post_op


def frozen_firmware(users, project, sources, board, *, value="500"):  # noqa: F811
    content = declaration(sources, board)
    content["configuration"][0]["value"] = value
    draft = op(
        users["owner"],
        "firmware.create",
        {
            "project_id": project,
            "name": f"Synthetic blink {value}",
            "firmware": content,
        },
    )
    return op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )


@pytest.fixture
def pair(users, project, sources, board):  # noqa: F811
    first = frozen_firmware(users, project, sources, board)
    second = frozen_firmware(users, project, sources, board, value="900")
    module = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic controller module",
            "assembly": {
                "occurrences": [
                    {
                        "local_id": "board",
                        "display_ref": "A1",
                        "revision_id": board[0]["revision_id"],
                        "assignments": {"firmware_revision_id": first["revision_id"]},
                    }
                ]
            },
        },
    )
    module_revision = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": module["draft_id"]},
        expected_state=module["state"],
    )
    assembly = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic repeated controllers",
            "assembly": {
                "occurrences": [
                    {
                        "local_id": local,
                        "display_ref": "A1",
                        "revision_id": module_revision["revision_id"],
                    }
                    for local in ("left", "right")
                ]
            },
        },
    )
    return assembly, first, second


def preview(users, assembly, firmware, path=None):
    return op(
        users["viewer"],
        "firmware_occurrence.review",
        {
            "draft_id": assembly["draft_id"],
            "path": path if path is not None else ["right", "board"],
            "firmware_revision_id": firmware,
        },
    )


def adoption_payload(preview):
    return {
        key: preview[key] for key in ("draft_id", "path", "firmware_revision_id", "review_sha256")
    } | {"basis": "Reviewed independent synthetic occurrence configuration"}


def adopt(users, reviewed, **kwargs):
    return op(
        users["editor"],
        "firmware_occurrence.adopt",
        adoption_payload(reviewed),
        expected_state=reviewed["state"],
        **kwargs,
    )


def rows(user, **owner):
    return op(user, "firmware_occurrence.inspect", owner)


def test_nested_repeated_boards_keep_independent_configs_and_frozen_copper(users, pair, board):  # noqa: F811
    assembly, first, second = pair
    historic = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    before_canonical = bytes(Revision.objects.get(id=historic["revision_id"]).snapshot.canonical)
    reviewed = preview(users, assembly, second["revision_id"])
    assert reviewed["eligible"] and reviewed["previous"]["revision_id"] == first["revision_id"]
    assert reviewed["candidate"]["content"]["firmware"]["configuration"][0]["value"] == "900"
    result = adopt(users, reviewed)
    inspected = rows(users["viewer"], draft_id=assembly["draft_id"])
    resolved = {tuple(row["path"]): row for row in inspected["occurrences"]}
    left, right = resolved[("left", "board")], resolved[("right", "board")]
    assert left["revision_id"] == right["revision_id"] == board[0]["revision_id"]
    assert left["snapshot_sha256"] == right["snapshot_sha256"]
    assert left["firmware_revision_id"] == first["revision_id"]
    assert right["firmware_revision_id"] == second["revision_id"]
    assert (
        result["content"]["assembly"]["occurrences"]
        == assembly["content"]["assembly"]["occurrences"]
    )
    frozen = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=result["state"],
    )
    review = op(
        users["viewer"],
        "firmware.assignment_review",
        {"assembly_snapshot_id": frozen["snapshot_id"]},
    )
    assert {tuple(row["path"]): row["firmware_revision_id"] for row in review["assignments"]} == {
        ("left", "board"): first["revision_id"],
        ("right", "board"): second["revision_id"],
    }
    assert {row["status"] for row in review["assignments"]} == {"valid"}
    old = rows(users["viewer"], snapshot_id=historic["snapshot_id"])
    assert {
        row["firmware_revision_id"] for row in old["occurrences"] if row["kind"] == "pcb_population"
    } == {first["revision_id"]}
    assert (
        bytes(Revision.objects.get(id=historic["revision_id"]).snapshot.canonical)
        == before_canonical
    )
    evidence = op(
        users["viewer"], "firmware_occurrence.read_adoption", {"adoption_id": result["adoption_id"]}
    )
    assert evidence["review"]["candidate"]["evaluation"]["sources"][0]["manifest_sha256"]
    assert (
        evidence["review"]["previous"]["content"]["firmware"]["configuration"][0]["value"] == "500"
    )
    assert inspected["adoptions"][0]["adoption_id"] == result["adoption_id"]
    assert evidence["compilation"] == "not_performed" and evidence["flashing"] == "not_performed"


def test_explicit_unassignment_masks_nested_inheritance(users, pair):
    assembly, first, _ = pair
    result = adopt(users, preview(users, assembly, None))
    paths = {
        tuple(row["path"]): row["firmware_revision_id"]
        for row in rows(users["viewer"], draft_id=assembly["draft_id"])["occurrences"]
    }
    assert paths[("left", "board")] == first["revision_id"]
    assert paths[("right", "board")] is None
    assert result["review"]["candidate"] is None


def test_wrong_population_is_reviewed_but_cannot_be_adopted(users, pair, project, sources, board):  # noqa: F811
    assembly, _, _ = pair
    changed_board = op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": board[1]["draft_id"]},
        expected_state=Draft.objects.get(id=board[1]["draft_id"]).state_token,
    )
    wrong = frozen_firmware(users, project, sources, (changed_board, board[1]))
    reviewed = preview(users, assembly, wrong["revision_id"])
    assert not reviewed["eligible"]
    with pytest.raises(ValidationFailed, match="does not match"):
        adopt(users, reviewed)
    assert Draft.objects.get(id=assembly["draft_id"]).state_token == assembly["state"]
    assert not FirmwareAdoption.objects.exists()


def test_stale_review_and_changed_digest_roll_back(users, pair):
    assembly, _, second = pair
    reviewed = preview(users, assembly, second["revision_id"])
    with pytest.raises(Conflict, match="review this occurrence"):
        op(
            users["editor"],
            "firmware_occurrence.adopt",
            {**adoption_payload(reviewed), "review_sha256": "0" * 64},
            expected_state=reviewed["state"],
        )
    assert not FirmwareAdoption.objects.exists()
    adopt(users, reviewed)
    with pytest.raises(Conflict, match="Draft changed"):
        adopt(users, reviewed)
    assert FirmwareAdoption.objects.count() == 1


def test_scoped_replay_mismatch_and_edit_permission(users, pair):
    assembly, _, second = pair
    reviewed = preview(users, assembly, second["revision_id"])
    saved = adopt(users, reviewed, idempotency_key="independent")
    assert adopt(users, reviewed, idempotency_key="independent") == saved
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "firmware_occurrence.adopt",
            {**adoption_payload(reviewed), "basis": "Changed review"},
            expected_state=reviewed["state"],
            idempotency_key="independent",
        )
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "firmware_occurrence.adopt",
            adoption_payload(reviewed),
            expected_state=reviewed["state"],
        )
    set_role(
        users["editor"],
        "viewer",
        workspace=str(Draft.objects.get(id=assembly["draft_id"]).definition.workspace_id),
    )
    with pytest.raises(PermissionDenied):
        adopt(users, reviewed, idempotency_key="independent")
    with pytest.raises(NotFound):
        rows(users["outsider"], draft_id=assembly["draft_id"])
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "firmware_occurrence.read_adoption",
            {"adoption_id": saved["adoption_id"]},
        )


def test_retained_source_authority_precedes_changed_request(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
):
    firmware = frozen_firmware(users, project, sources, board)
    assembly = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic direct controller",
            "assembly": {
                "occurrences": [{"local_id": "board", "revision_id": board[0]["revision_id"]}]
            },
        },
    )
    reviewed = preview(users, assembly, firmware["revision_id"], ["board"])
    saved = adopt(users, reviewed, idempotency_key="retained")
    # Remove the assigned firmware from current design; immutable evidence retains its pins.
    updated = op(
        users["editor"],
        "assembly.update",
        {"draft_id": assembly["draft_id"], "assembly": assembly["content"]["assembly"]},
        expected_state=saved["state"],
    )
    clean_review = preview(users, updated, None, ["board"])
    # Retained results are authorized afresh: a role downgrade denies, and workspace
    # membership loss hides the key and the adoption before the changed-request conflict.
    set_role(users["editor"], "viewer", project=project)
    with pytest.raises(PermissionDenied):
        adopt(users, clean_review, idempotency_key="retained")
    remove_member(users["editor"], project=project)
    remove_member(users["viewer"], project=project)
    with pytest.raises(NotFound):
        adopt(users, clean_review, idempotency_key="retained")
    with pytest.raises(NotFound):
        op(
            users["viewer"],
            "firmware_occurrence.read_adoption",
            {"adoption_id": saved["adoption_id"]},
        )
    assert FirmwareAdoption.objects.count() == 1


def test_full_retained_ancestor_dependency_precedes_paths(users, pair, workspace, other_workspace):
    assembly, _, second = pair
    snapshot = Revision.objects.get(id=second["revision_id"]).snapshot

    def board_revision(user, workspace_id, name):
        definition = op(
            user,
            "definition.create",
            {"workspace_id": workspace_id, "name": name, "kind": "board"},
        )
        return op(
            user,
            "draft.freeze",
            {"draft_id": definition["draft_id"]},
            expected_state=definition["state"],
        )

    # Retained pins never cross workspaces: the database rejects a foreign ancestor.
    foreign = board_revision(users["outsider"], other_workspace, "Foreign ancestor")
    with pytest.raises(IntegrityError), transaction.atomic():
        SnapshotDependency.objects.create(snapshot=snapshot, revision_id=foreign["revision_id"])
    # A same-workspace retained ancestor is part of the full dependency authority.
    origin = board_revision(users["owner"], workspace, "Retained ancestor")
    SnapshotDependency.objects.create(snapshot=snapshot, revision_id=origin["revision_id"])
    with pytest.raises(NotFound):
        preview(users, assembly, second["revision_id"], ["missing"])
    # Authority is checked before the path diagnostic, so losing the workspace hides both.
    remove_member(users["viewer"])
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        preview(users, assembly, second["revision_id"], ["missing"])


def test_invalid_payload_and_missing_path_never_write(users, pair):
    assembly, _, second = pair
    for path in ([], ["BAD"]):
        with pytest.raises(ValidationFailed):
            preview(users, assembly, second["revision_id"], path)
    with pytest.raises(NotFound):
        preview(users, assembly, second["revision_id"], ["missing"])
    reviewed = preview(users, assembly, second["revision_id"])
    for basis in ("", "   "):
        with pytest.raises(ValidationFailed):
            op(
                users["editor"],
                "firmware_occurrence.adopt",
                {**adoption_payload(reviewed), "basis": basis},
                expected_state=reviewed["state"],
            )
    assert not FirmwareAdoption.objects.exists()


def test_database_evidence_is_immutable_and_invalid_links_rejected(users, pair):
    assembly, _, second = pair
    saved = adopt(users, preview(users, assembly, second["revision_id"]))
    row = FirmwareAdoption.objects.get(id=saved["adoption_id"])
    for mutate in (
        lambda: FirmwareAdoption.objects.filter(pk=row.id).update(basis="changed"),
        lambda: FirmwareAdoption.objects.filter(pk=row.id).delete(),
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            mutate()
    values = {
        field.name: getattr(row, field.name)
        for field in row._meta.fields
        if field.name not in {"id", "created_at"}
    }
    values["path"] = ["other"]
    with pytest.raises(IntegrityError), transaction.atomic():
        FirmwareAdoption.objects.create(**values)


def test_http_and_jobs_share_review_adoption_and_denial(users, pair):
    assembly, _, second = pair
    payload = {
        "draft_id": assembly["draft_id"],
        "path": ["right", "board"],
        "firmware_revision_id": second["revision_id"],
    }
    reviewed = post_op(api(users["viewer"]), "firmware_occurrence.review", payload)
    assert reviewed.status_code == 200
    body = reviewed.json()["result"]
    denied = post_op(
        api(users["viewer"]),
        "firmware_occurrence.adopt",
        adoption_payload(body),
        expected_state=body["state"],
    )
    assert denied.status_code == 403
    saved = post_op(
        api(users["editor"]),
        "firmware_occurrence.adopt",
        adoption_payload(body),
        expected_state=body["state"],
        idempotency_key="http",
    )
    assert saved.status_code == 200 and saved.json()["result"]["adoption_id"]
    assert FirmwareAdoption.objects.count() == 1
    assert (
        post_op(
            api(users["viewer"]), "firmware_occurrence.inspect", {"draft_id": assembly["draft_id"]}
        ).status_code
        == 200
    )
    assert post_op(api(users["outsider"]), "firmware_occurrence.review", payload).status_code == 404
    assert (
        post_op(
            api(users["viewer"]),
            "firmware_occurrence.inspect",
            {"draft_id": assembly["draft_id"]},
            idempotency_key="read",
        ).status_code
        == 422
    )


def test_adoption_failure_rolls_back_assignment(users, pair, monkeypatch):
    assembly, _, second = pair
    reviewed = preview(users, assembly, second["revision_id"])

    def fail(**kwargs):
        raise IntegrityError("Synthetic evidence failure")

    monkeypatch.setattr(FirmwareAdoption.objects, "create", fail)
    with pytest.raises(IntegrityError):
        adopt(users, reviewed, idempotency_key="rollback")
    assert Draft.objects.get(id=assembly["draft_id"]).state_token == reviewed["state"]
    assert not IdempotencyRecord.objects.filter(operation="firmware_occurrence.adopt").exists()
    assert not FirmwareAdoption.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_competing_reviewed_adoptions_have_one_winner(users, pair):
    assembly, _, second = pair
    reviewed = preview(users, assembly, second["revision_id"])
    barrier = Barrier(2)

    def attempt_adoption(_):
        close_old_connections()
        barrier.wait(timeout=10)
        try:
            adopt(users, reviewed)
            return "adopted"
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(attempt_adoption, range(2)))
    assert sorted(outcomes) == ["adopted", "conflict"]
    assert FirmwareAdoption.objects.count() == 1
    assert Draft.objects.get(id=assembly["draft_id"]).version == 2


@pytest.mark.parametrize("corruption", ["review_hash", "before_content", "candidate", "previous"])
def test_sql_rejects_forged_review_provenance_and_rolls_back(users, pair, monkeypatch, corruption):
    import copy
    import hashlib

    from specmate.design.operations import canonical_bytes

    assembly, _, second = pair
    reviewed = preview(users, assembly, second["revision_id"])
    create_evidence = FirmwareAdoption.objects.create

    def corrupted(**values):
        values = copy.deepcopy(values)
        if corruption == "before_content":
            values["before_content"] = {}
        elif corruption == "review_hash":
            values["review_sha256"] = values["review"]["review_sha256"] = "0" * 64
        else:
            values["review"][corruption]["content"]["firmware"]["configuration"][0]["value"] = (
                "forged"
            )
            # Even internally consistent hashes cannot authorize different frozen content.
            raw = canonical_bytes(
                {k: v for k, v in values["review"].items() if k != "review_sha256"}
            )
            values["review_sha256"] = values["review"]["review_sha256"] = hashlib.sha256(
                raw
            ).hexdigest()
            if "review_canonical" in values:
                values["review_canonical"] = raw
        return create_evidence(**values)

    monkeypatch.setattr(FirmwareAdoption.objects, "create", corrupted)
    with pytest.raises(IntegrityError):
        adopt(users, reviewed, idempotency_key="forged")
    assert Draft.objects.get(id=assembly["draft_id"]).content == assembly["content"]
    assert not FirmwareAdoption.objects.exists()
    assert not IdempotencyRecord.objects.filter(operation="firmware_occurrence.adopt").exists()


def test_retained_adoption_rechecks_original_base_after_new_freeze(users, pair, workspace):
    assembly, _, second = pair
    original = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace, "kind": "board", "name": "Historic provenance"},
    )
    dependency = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": original["draft_id"]},
        expected_state=original["state"],
    )
    historic = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    SnapshotDependency.objects.create(
        snapshot_id=historic["snapshot_id"], revision_id=dependency["revision_id"]
    )
    reviewed = preview(users, assembly, second["revision_id"])
    saved = adopt(users, reviewed, idempotency_key="original-base")
    op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=saved["state"],
    )
    assert op(
        users["viewer"], "firmware_occurrence.read_adoption", {"adoption_id": saved["adoption_id"]}
    )
    # Membership loss hides the retained adoption and its key; a later freeze changes nothing.
    for actor in ("editor", "viewer"):
        remove_member(users[actor])
    with pytest.raises(NotFound):
        op(
            users["viewer"],
            "firmware_occurrence.read_adoption",
            {"adoption_id": saved["adoption_id"]},
        )
    with pytest.raises(NotFound):
        adopt(users, reviewed, idempotency_key="original-base")


@pytest.mark.django_db(transaction=True)
def test_distinct_competing_adoptions_preserve_only_the_winners_change(users, pair):
    assembly, first, second = pair
    reviews = [
        preview(users, assembly, second["revision_id"]),
        preview(users, assembly, None, ["left", "board"]),
    ]
    barrier = Barrier(2)

    def compete(index):
        close_old_connections()
        barrier.wait(timeout=10)
        try:
            result = adopt(users, reviews[index], idempotency_key=f"competing-{index}")
            return index, result
        except Conflict:
            return index, None
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(compete, range(2)))
    winners = [(index, result) for index, result in results if result is not None]
    assert len(winners) == 1
    winner, result = winners[0]
    stored = Draft.objects.get(id=assembly["draft_id"])
    assert stored.content == result["content"] and stored.version == 2
    evidence = FirmwareAdoption.objects.get()
    assert evidence.after_content == stored.content
    assert evidence.before_content == assembly["content"]
    assert evidence.path == reviews[winner]["path"]
    assert IdempotencyRecord.objects.filter(operation="firmware_occurrence.adopt").count() == 1
    actual = {
        tuple(row["path"]): row["firmware_revision_id"]
        for row in rows(users["viewer"], draft_id=assembly["draft_id"])["occurrences"]
    }
    assert actual[("left", "board")] == (first["revision_id"] if winner == 0 else None)
    assert actual[("right", "board")] == (
        second["revision_id"] if winner == 0 else first["revision_id"]
    )


def test_unknown_configuration_and_toolchain_are_retained_as_declarations(users, pair):
    import copy

    assembly, _, second = pair
    revision = Revision.objects.get(id=second["revision_id"])
    draft = Draft.objects.get(definition=revision.definition)
    value = copy.deepcopy(draft.content["firmware"])
    value["toolchain"]["version"] = None
    value["configuration"].append({"key": "SENSOR", "status": "unknown", "value": None})
    edited = op(
        users["owner"],
        "firmware.update",
        {"draft_id": str(draft.id), "firmware": value},
        expected_state=draft.state_token,
    )
    frozen = op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": str(draft.id)},
        expected_state=edited["state"],
    )
    reviewed = preview(users, assembly, frozen["revision_id"])
    assert reviewed["eligible"]
    assert reviewed["candidate"]["evaluation"]["readiness"] == "declared_with_unknowns"
    saved = adopt(users, reviewed)
    retained = op(
        users["viewer"], "firmware_occurrence.read_adoption", {"adoption_id": saved["adoption_id"]}
    )
    assert retained["review"]["candidate"]["content"]["firmware"]["toolchain"]["version"] is None
    assert retained["compilation"] == retained["flashing"] == "not_performed"


def test_inactive_actor_cannot_read_review_adopt_or_replay_retained_evidence(users, pair):
    from specmate.operations import Unauthenticated

    assembly, _, second = pair
    reviewed = preview(users, assembly, second["revision_id"])
    saved = adopt(users, reviewed, idempotency_key="actor")
    type(users["editor"]).objects.filter(pk=users["editor"].pk).update(is_active=False)
    assert users["editor"].is_active
    for name, payload, context in (
        ("firmware_occurrence.inspect", {"draft_id": assembly["draft_id"]}, {}),
        (
            "firmware_occurrence.review",
            {k: reviewed[k] for k in ("draft_id", "path", "firmware_revision_id")},
            {},
        ),
        (
            "firmware_occurrence.adopt",
            adoption_payload(reviewed),
            {"expected_state": reviewed["state"], "idempotency_key": "actor"},
        ),
        ("firmware_occurrence.read_adoption", {"adoption_id": saved["adoption_id"]}, {}),
    ):
        with pytest.raises(Unauthenticated):
            op(users["editor"], name, payload, **context)
