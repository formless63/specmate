"""Independent authority and exact-input regressions; no native tool is executed."""

import json

# Imported pytest fixtures are deliberately rebound by test parameters.
# ruff: noqa: F811
from uuid import UUID, uuid4

import pytest
from django.contrib.auth import get_user_model
from django.db import DatabaseError, transaction

from specmate.access.models import WorkspaceMember
from specmate.catalog.models import Representation
from specmate.design.models import Draft, Revision, SnapshotDependency
from specmate.mechanical_sources.operations import require_freezable
from specmate.operations import Context, NotFound, Unauthenticated, ValidationFailed, execute

from .conftest import member, op, remove_member
from .scope_helpers import workspace_of
from .test_firmware import MCU, attempt, board, intake, recipe, source  # noqa: F401
from .test_mechanical_sources import (  # noqa: F401
    DATA,
    MODEL,
    create,
    declaration,
    digest,
    mec_sources,
    mec_target,
)
from .test_sources import register


def second_source(users, workspace):
    """A second preserved original in the same workspace, independent of the fixtures."""
    register(users["owner"], workspace, DATA)
    result = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(workspace),
            "name": "Original recipe",
            "files": [
                {
                    "path": "case.py",
                    "sha256": digest(DATA),
                    "rights": "MIT",
                    "media_type": "text/plain",
                }
            ],
        },
    )
    return workspace, result


def test_retained_source_denial_precedes_changed_pin_diagnostics(
    users, workspace, mec_sources, mec_target
):
    _, original = second_source(users, workspace)
    old = declaration(original, mec_target)
    old["sources"][0]["files"] = old["sources"][0]["files"][:1]
    created = create(users["editor"], workspace, old, idempotency_key="retained")
    new = declaration(mec_sources, mec_target)
    op(
        users["editor"],
        "mechanical_source.update",
        {"draft_id": created["draft_id"], "mechanical_source": new},
        expected_state=created["state"],
    )
    assert op(users["editor"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    remove_member(users["editor"])
    new["sources"][0]["files"][0]["sha256"] = "0" * 64
    with pytest.raises(NotFound):
        create(users["editor"], workspace, new, idempotency_key="retained")


def test_complete_source_set_authorized_before_manifest_mismatch(
    users, workspace, mec_sources, mec_target
):
    _, original = second_source(users, workspace)
    remove_member(users["editor"])
    content = declaration(mec_sources, mec_target)
    content["sources"][0]["source_manifest_sha256"] = "0" * 64
    content["sources"].append(
        {
            **content["sources"][0],
            "local_id": "hidden",
            "source_revision_id": original["revision_id"],
        }
    )
    with pytest.raises(NotFound):
        create(users["editor"], workspace, content)


def test_snapshot_dependency_cannot_cross_workspaces(
    users, other_workspace, mec_sources, mec_target
):
    hidden = op(
        users["outsider"],
        "definition.create",
        {"workspace_id": other_workspace, "kind": "hardware", "name": "Ancestor"},
    )
    frozen = op(
        users["outsider"],
        "draft.freeze",
        {"draft_id": hidden["draft_id"]},
        expected_state=hidden["state"],
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        SnapshotDependency.objects.create(
            snapshot=Revision.objects.get(id=mec_target["revision_id"]).snapshot,
            revision_id=frozen["revision_id"],
        )


def test_model_source_membership_checked_before_wrong_revision(
    users, workspace, mec_sources, mec_target
):
    model = op(
        users["editor"],
        "catalog.register_representation",
        {
            "rights_status": "unknown",
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Independent model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    replacement = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace,
            "name": "Independent visible model source",
            "files": [
                {
                    "path": "case.py",
                    "sha256": digest(DATA),
                    "media_type": "text/plain",
                    "rights": "MIT",
                },
                {
                    "path": "body.step",
                    "sha256": digest(MODEL),
                    "media_type": "model/step",
                    "rights": "MIT",
                },
                {
                    "path": "unsupported.bin",
                    "sha256": digest(b"opaque"),
                    "media_type": "application/octet-stream",
                    "rights": "MIT",
                },
            ],
        },
    )
    content = declaration(replacement, mec_target)
    content["models"] = [
        {
            "local_id": "body",
            "representation_id": model["representation_id"],
            "revision_id": mec_target["revision_id"],
            "snapshot_sha256": "0" * 64,
            "source_local_id": "native",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "clearance",
            "basis": "Unverified correspondence",
        }
    ]
    with pytest.raises(ValidationFailed):
        create(users["editor"], workspace, content)
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        create(users["editor"], workspace, content)
    assert Representation.objects.filter(id=model["representation_id"]).exists()


@pytest.mark.parametrize(
    "option,component", [("missing", MCU), ("no-mcu", MCU), (None, str(uuid4()))]
)
def test_invalid_board_selection_blocks_capture(
    users, workspace, mec_sources, board, option, component
):
    frozen, _ = board
    revision = Revision.objects.get(id=frozen["revision_id"])
    population = json.loads(bytes(revision.snapshot.canonical))["content"]["pcb_population"]
    content = declaration(mec_sources, frozen)
    content["targets"] = [
        {
            "local_id": "fastener",
            "role": "component",
            "revision_id": frozen["revision_id"],
            "snapshot_sha256": frozen["sha256"],
            "native_component_id": component,
            "basis": "Exact board input",
            "board": {
                k: population[k]
                for k in (
                    "interpretation_id",
                    "interpretation_sha256",
                    "source_revision_id",
                    "source_manifest_sha256",
                )
            },
        }
    ]
    content["targets"][0]["board"]["option_id"] = option
    created = create(users["editor"], workspace, content)
    result = op(users["viewer"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    assert result["evaluation"]["readiness"] == "blocked"
    with pytest.raises(ValidationFailed, match="block capture"):
        op(
            users["owner"],
            "mechanical_source.freeze",
            {"draft_id": created["draft_id"]},
            expected_state=created["state"],
        )
    assert not Revision.objects.filter(definition_id=created["definition_id"]).exists()
    assert Draft.objects.get(id=created["draft_id"]).version == 1


def test_empty_placeholder_is_not_freezable(users, workspace):
    created = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace, "kind": "mechanical_source", "name": "Pending declaration"},
    )
    draft = Draft.objects.get(id=created["draft_id"])
    with pytest.raises(ValidationFailed, match="Typed mechanical"):
        require_freezable(users["owner"], draft.definition, draft.content)
    with pytest.raises(ValidationFailed, match="Typed mechanical"):
        op(
            users["owner"],
            "mechanical_source.freeze",
            {"draft_id": created["draft_id"]},
            expected_state=created["state"],
        )


def test_stale_actor_rejected_before_read_or_replay(users, workspace, mec_sources, mec_target):
    content = declaration(mec_sources, mec_target)
    created = create(users["editor"], workspace, content, idempotency_key="actor")
    get_user_model().objects.filter(pk=users["editor"].pk).update(is_active=False)
    for name, payload, key in [
        ("mechanical_source.read", {"draft_id": created["draft_id"]}, None),
        (
            "mechanical_source.create",
            {
                "workspace_id": workspace,
                "name": "Reusable synthetic enclosure",
                "mechanical_source": content,
            },
            "actor",
        ),
    ]:
        with pytest.raises(Unauthenticated):
            execute(
                name,
                Context(user=users["editor"], request_id="stale", via="api", idempotency_key=key),
                payload,
            )


def test_target_catalog_adoption_is_current_membership_authority(
    users, workspace, mec_sources, mec_target
):
    from specmate.catalog_packs.models import AdoptionEntry

    from .test_catalog_packs import adopt, install, registered

    foreign = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace, "kind": "hardware", "name": "Reusable hardware"},
    )
    frozen = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": foreign["draft_id"]},
        expected_state=foreign["state"],
    )
    version = registered(users, workspace, frozen)
    install(users, version)
    adopt(users, version)
    copied = AdoptionEntry.objects.get()
    target = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": str(copied.draft_id)},
        expected_state=copied.draft.state_token,
    )
    content = declaration(mec_sources, target)
    created = create(users["editor"], workspace, content, idempotency_key="origin")
    remove_member(users["editor"])
    for action in (
        lambda: op(users["editor"], "mechanical_source.read", {"draft_id": created["draft_id"]}),
        lambda: create(users["editor"], workspace, content, idempotency_key="origin"),
        lambda: op(
            users["editor"],
            "mechanical_source.update",
            {
                "draft_id": created["draft_id"],
                "mechanical_source": declaration(mec_sources, mec_target),
            },
            expected_state="draft-v999",
        ),
    ):
        with pytest.raises(NotFound):
            action()


@pytest.mark.parametrize("operation", ["update", "freeze"])
def test_retained_mutation_closure_survives_changed_draft(
    users, workspace, mec_sources, mec_target, operation
):
    _, original = second_source(users, workspace)
    membership = WorkspaceMember.objects.get(workspace_id=workspace, user=users["editor"])
    membership.grants = ["design.freeze"]
    membership.save()
    old = declaration(original, mec_target)
    old["sources"][0]["files"] = old["sources"][0]["files"][:1]
    created = create(users["editor"], workspace, old)
    payload = {"draft_id": created["draft_id"]}
    if operation == "update":
        payload["mechanical_source"] = old
    retained = op(
        users["editor"],
        "mechanical_source." + operation,
        payload,
        expected_state=created["state"],
        idempotency_key="retained-mutation",
    )
    state = retained["state"] if operation == "update" else retained["draft"]["state"]
    replacement = declaration(mec_sources, mec_target)
    op(
        users["editor"],
        "mechanical_source.update",
        {"draft_id": created["draft_id"], "mechanical_source": replacement},
        expected_state=state,
    )
    remove_member(users["editor"])
    if operation == "update":
        replacement["targets"][0]["snapshot_sha256"] = "0" * 64
        payload["mechanical_source"] = replacement
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "mechanical_source." + operation,
            payload,
            expected_state=created["state"],
            idempotency_key="retained-mutation",
        )


@pytest.mark.django_db(transaction=True)
def test_competing_updates_keep_winner_data(users, workspace, mec_sources, mec_target):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connection

    from specmate.operations import Conflict

    created = create(users["editor"], workspace, declaration(mec_sources, mec_target))
    barrier = Barrier(2)

    def update(role):
        close_old_connections()
        try:
            content = declaration(mec_sources, mec_target)
            content["item_role"] = role
            barrier.wait(timeout=10)
            try:
                result = op(
                    users["editor"],
                    "mechanical_source.update",
                    {"draft_id": created["draft_id"], "mechanical_source": content},
                    expected_state=created["state"],
                    idempotency_key=role,
                )
                return role, result
            except Conflict:
                return role, None
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(update, ("part", "hardware")))
    winners = [(role, result) for role, result in outcomes if result is not None]
    assert len(winners) == 1
    draft = Draft.objects.get(id=created["draft_id"])
    assert draft.version == 2
    assert draft.content["mechanical_source"]["item_role"] == winners[0][0]
    assert winners[0][1]["content"] == draft.content


def test_target_summary_excludes_models_but_exact_lookup_includes_them(
    users, workspace, mec_sources, mec_target
):
    from django.test import RequestFactory

    from specmate.mechanical_sources.api import list_targets, read_target

    op(
        users["editor"],
        "catalog.register_representation",
        {
            "rights_status": "unknown",
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Protected model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    request = RequestFactory().get("/")
    request.user = users["viewer"]
    page = list_targets(request, UUID(workspace))
    summary = next(
        row for row in page["targets"] if row["revision_id"] == mec_target["revision_id"]
    )
    assert summary["models"] == [] and summary["board"] is None
    assert read_target(request, UUID(mec_target["revision_id"]))["models"]
    remove_member(users["viewer"])
    with pytest.raises(NotFound):
        list_targets(request, UUID(workspace))
    with pytest.raises(NotFound):
        read_target(request, UUID(mec_target["revision_id"]))


def test_uninterpreted_board_unknowns_require_current_membership(
    users, workspace, mec_sources, mec_target
):
    # The board-role fallback exposes unknown geometry for an uninterpreted board revision
    # in the same workspace, and only to current members.
    from specmate.mechanical_sources.contracts import MechanicalSource
    from specmate.mechanical_sources.operations import evaluate

    original = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace, "kind": "board", "name": "Original board"},
    )
    board_revision = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": original["draft_id"]},
        expected_state=original["state"],
    )
    target = Revision.objects.get(id=mec_target["revision_id"])
    content = declaration(mec_sources, mec_target)
    content["targets"][0]["role"] = "board"
    assert board_revision["revision_id"]
    assert evaluate(users["editor"], target.definition, MechanicalSource.model_validate(content))
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        evaluate(users["editor"], target.definition, MechanicalSource.model_validate(content))


@pytest.mark.parametrize(
    "command", ["definition.create", "draft.update", "draft.snapshot", "draft.freeze"]
)
def test_generic_replay_denies_non_member_before_changed_request(
    users, workspace, mec_sources, mec_target, command
):
    _, original = second_source(users, workspace)
    old = declaration(original, mec_target)
    old["sources"][0]["files"] = old["sources"][0]["files"][:1]
    payload = {
        "workspace_id": workspace,
        "kind": "mechanical_source",
        "name": "Generic retained source",
        "content": {"mechanical_source": old},
    }
    created = op(
        users["owner"],
        "definition.create",
        payload,
        idempotency_key="generic-retained" if command == "definition.create" else None,
    )
    state = created["state"]
    if command != "definition.create":
        payload = {"draft_id": created["draft_id"]}
        if command == "draft.update":
            payload["changes"] = {"mechanical_source": old}
        stored = op(
            users["owner"],
            command,
            payload,
            expected_state=state,
            idempotency_key="generic-retained",
        )
        if command == "draft.update":
            state = stored["state"]
        elif command == "draft.freeze":
            state = stored["draft"]["state"]
    new = declaration(mec_sources, mec_target)
    current = op(
        users["owner"],
        "draft.update",
        {"draft_id": created["draft_id"], "changes": {"mechanical_source": new}},
        expected_state=state,
    )
    from .test_transports import api

    client = api(users["owner"])
    assert client.get(f"/api/v0/drafts/{created['draft_id']}").status_code == 200
    assert client.get(f"/api/v0/mechanical-sources/drafts/{created['draft_id']}").status_code == 200
    if command == "draft.freeze":
        revision = stored["revision_id"]
        assert client.get(f"/api/v0/revisions/{revision}/snapshot").status_code == 200
    remove_member(users["owner"])
    assert client.get(f"/api/v0/drafts/{created['draft_id']}").status_code == 404
    assert client.get(f"/api/v0/mechanical-sources/drafts/{created['draft_id']}").status_code == 404
    if command == "draft.freeze":
        assert client.get(f"/api/v0/revisions/{revision}/snapshot").status_code == 404
        assert client.get(f"/api/v0/mechanical-sources/revisions/{revision}").status_code == 404
    member(users["owner"], "admin")  # prepare the changed request, then lose access again
    if command == "definition.create":
        payload["kind"] = "hardware"
        payload["content"] = {}
    elif command == "draft.update":
        payload["changes"] = {"mechanical_source": new}
    if command == "draft.update":
        unrelated = op(
            users["owner"],
            "definition.create",
            {
                "workspace_id": workspace,
                "kind": "hardware",
                "name": "Unrelated incoming draft",
            },
        )
        payload["draft_id"] = unrelated["draft_id"]
    remove_member(users["owner"])
    # A retained result is never revealed to a non-member, whatever the request says.
    with pytest.raises(NotFound):
        op(
            users["owner"],
            command,
            payload,
            expected_state=current["state"] if command != "definition.create" else None,
            idempotency_key="generic-retained",
        )

    # With membership restored, the same changed request reports the documented key
    # mismatch; it must never execute again.
    from specmate.operations import IdempotencyMismatch

    member(users["owner"], "admin")
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            command,
            payload,
            expected_state=current["state"] if command != "definition.create" else None,
            idempotency_key="generic-retained",
        )


def test_generic_firmware_retained_source_denial_precedes_key_mismatch(users, workspace, board):
    from .test_firmware import CONFIG, MAIN
    from .test_firmware import declaration as firmware_declaration

    files = []
    for path, data in (("src/main.cpp", MAIN), ("platformio.ini", CONFIG)):
        register(users["owner"], workspace, data)
        files.append(
            {"path": path, "sha256": digest(data), "rights": "MIT", "media_type": "text/plain"}
        )
    original = op(
        users["owner"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Firmware retained origin", "files": files},
    )
    payload = {
        "workspace_id": workspace,
        "kind": "firmware",
        "name": "Generic firmware retained source",
        "content": {"firmware": firmware_declaration(original, board)},
    }
    created = op(users["owner"], "definition.create", payload, idempotency_key="firmware-retained")
    replacement = op(
        users["owner"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Readable firmware replacement", "files": files},
    )
    new = {"firmware": firmware_declaration(replacement, board)}
    op(
        users["owner"],
        "draft.update",
        {"draft_id": created["draft_id"], "changes": new},
        expected_state=created["state"],
    )
    remove_member(users["owner"])
    payload["content"] = new
    with pytest.raises(NotFound):
        op(users["owner"], "definition.create", payload, idempotency_key="firmware-retained")
    member(users["owner"], "admin")
    from specmate.operations import IdempotencyMismatch

    with pytest.raises(IdempotencyMismatch):
        op(users["owner"], "definition.create", payload, idempotency_key="firmware-retained")
