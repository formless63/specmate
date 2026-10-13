"""Independent authority and exact-input regressions; no native tool is executed."""

import json

# Imported pytest fixtures are deliberately rebound by test parameters.
# ruff: noqa: F811
from uuid import UUID, uuid4

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import Membership
from specmate.catalog.models import Representation
from specmate.design.models import Draft, Revision, SnapshotDependency
from specmate.mechanical_sources.operations import require_freezable
from specmate.operations import Context, NotFound, Unauthenticated, ValidationFailed, execute
from specmate.sources.models import SourceBlob, SourceBundleFile

from .conftest import op
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


def foreign_source(users):
    project = op(users["outsider"], "project.create", {"name": "Independent source origin"})[
        "project_id"
    ]
    Membership.objects.create(project_id=project, user=users["editor"], role="viewer")
    register(users["outsider"], project, DATA)
    result = op(
        users["outsider"],
        "source.create_original_bundle",
        {
            "project_id": project,
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
    return project, result


def test_retained_source_denial_precedes_changed_pin_diagnostics(
    users, project, mec_sources, mec_target
):
    foreign_project, original = foreign_source(users)
    old = declaration(original, mec_target)
    old["sources"][0]["files"] = old["sources"][0]["files"][:1]
    created = create(users["editor"], project, old, idempotency_key="retained")
    new = declaration(mec_sources, mec_target)
    op(
        users["editor"],
        "mechanical_source.update",
        {"draft_id": created["draft_id"], "mechanical_source": new},
        expected_state=created["state"],
    )
    Membership.objects.filter(project_id=foreign_project, user=users["editor"]).delete()
    assert op(users["editor"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    new["sources"][0]["files"][0]["sha256"] = "0" * 64
    with pytest.raises(NotFound):
        create(users["editor"], project, new, idempotency_key="retained")


def test_complete_source_set_authorized_before_manifest_mismatch(
    users, project, mec_sources, mec_target
):
    foreign_project, original = foreign_source(users)
    Membership.objects.filter(project_id=foreign_project, user=users["editor"]).delete()
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
        create(users["editor"], project, content)


def test_target_retained_dependency_authority_precedes_pin_diagnostic(
    users, project, mec_sources, mec_target
):
    foreign_project = op(users["outsider"], "project.create", {"name": "Hidden target ancestor"})[
        "project_id"
    ]
    hidden = op(
        users["outsider"],
        "definition.create",
        {"project_id": foreign_project, "kind": "hardware", "name": "Ancestor"},
    )
    frozen = op(
        users["outsider"],
        "draft.freeze",
        {"draft_id": hidden["draft_id"]},
        expected_state=hidden["state"],
    )
    SnapshotDependency.objects.create(
        snapshot=Revision.objects.get(id=mec_target["revision_id"]).snapshot,
        revision_id=frozen["revision_id"],
    )
    content = declaration(mec_sources, mec_target)
    content["targets"][0]["snapshot_sha256"] = "0" * 64
    with pytest.raises(NotFound):
        create(users["editor"], project, content)


def test_model_actual_source_ancestry_authorized_before_wrong_revision(
    users, project, mec_sources, mec_target
):
    model = op(
        users["editor"],
        "catalog.register_representation",
        {
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Independent model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    # Append an inaccessible retained file to exercise full source authority, including
    # siblings outside the chosen model; source bytes and existing rows stay immutable.
    foreign_project, _ = foreign_source(users)
    register(users["outsider"], foreign_project, MODEL)
    SourceBundleFile.objects.create(
        revision_id=mec_sources["revision_id"],
        path="hidden.step",
        rights="private",
        media_type="model/step",
        blob=SourceBlob.objects.get(project_id=foreign_project, sha256=digest(MODEL)),
    )
    Membership.objects.filter(project_id=foreign_project, user=users["editor"]).delete()
    replacement = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "project_id": project,
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
    with pytest.raises(NotFound):
        create(users["editor"], project, content)
    assert Representation.objects.filter(id=model["representation_id"]).exists()


@pytest.mark.parametrize(
    "option,component", [("missing", MCU), ("no-mcu", MCU), (None, str(uuid4()))]
)
def test_invalid_board_selection_blocks_capture(
    users, project, mec_sources, board, option, component
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
    created = create(users["editor"], project, content)
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


def test_empty_placeholder_is_not_freezable(users, project):
    created = op(
        users["owner"],
        "definition.create",
        {"project_id": project, "kind": "mechanical_source", "name": "Pending declaration"},
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


def test_stale_actor_rejected_before_read_or_replay(users, project, mec_sources, mec_target):
    content = declaration(mec_sources, mec_target)
    created = create(users["editor"], project, content, idempotency_key="actor")
    get_user_model().objects.filter(pk=users["editor"].pk).update(is_active=False)
    for name, payload, key in [
        ("mechanical_source.read", {"draft_id": created["draft_id"]}, None),
        (
            "mechanical_source.create",
            {
                "project_id": project,
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


def test_target_catalog_origin_is_current_authority(users, project, mec_sources, mec_target):
    from specmate.catalog_packs.models import AdoptionEntry

    from .test_catalog_packs import adopt, install, registered

    foreign_project = op(users["outsider"], "project.create", {"name": "Catalog target origin"})[
        "project_id"
    ]
    Membership.objects.create(project_id=foreign_project, user=users["editor"], role="viewer")
    Membership.objects.create(project_id=foreign_project, user=users["owner"], role="viewer")
    foreign = op(
        users["outsider"],
        "definition.create",
        {
            "project_id": foreign_project,
            "kind": "hardware",
            "name": "Reusable hardware",
        },
    )
    frozen = op(
        users["outsider"],
        "draft.freeze",
        {"draft_id": foreign["draft_id"]},
        expected_state=foreign["state"],
    )
    version = registered(users, project, frozen)
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
    created = create(users["editor"], project, content, idempotency_key="origin")
    Membership.objects.filter(project_id=foreign_project, user=users["editor"]).delete()
    for action in (
        lambda: op(users["editor"], "mechanical_source.read", {"draft_id": created["draft_id"]}),
        lambda: create(users["editor"], project, content, idempotency_key="origin"),
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
    users, project, mec_sources, mec_target, operation
):
    foreign_project, original = foreign_source(users)
    membership = Membership.objects.get(project_id=project, user=users["editor"])
    membership.grants = ["design.freeze"]
    membership.save()
    old = declaration(original, mec_target)
    old["sources"][0]["files"] = old["sources"][0]["files"][:1]
    created = create(users["editor"], project, old)
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
    Membership.objects.filter(project_id=foreign_project, user=users["editor"]).delete()
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
def test_competing_updates_keep_winner_data(users, project, mec_sources, mec_target):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connection

    from specmate.operations import Conflict

    created = create(users["editor"], project, declaration(mec_sources, mec_target))
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


def test_target_summary_excludes_models_but_exact_lookup_requires_their_authority(
    users, project, mec_sources, mec_target
):
    from django.test import RequestFactory

    from specmate.mechanical_sources.api import list_targets, read_target
    from specmate.sources.models import SourceBundle

    op(
        users["editor"],
        "catalog.register_representation",
        {
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Protected model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    hidden = op(users["outsider"], "project.create", {"name": "Model origin"})["project_id"]
    SourceBundle.objects.filter(id=mec_sources["bundle_id"]).update(project_id=hidden)
    request = RequestFactory().get("/")
    request.user = users["viewer"]
    page = list_targets(request, UUID(project))
    summary = next(
        row for row in page["targets"] if row["revision_id"] == mec_target["revision_id"]
    )
    assert summary["models"] == [] and summary["board"] is None
    with pytest.raises(NotFound):
        read_target(request, UUID(mec_target["revision_id"]))


def test_uninterpreted_board_unknowns_require_retained_dependency_authority(
    users, project, mec_sources, mec_target
):
    # The new board-role fallback may expose unknown geometry only after exact
    # revision closure is authorized, including dependencies outside the project.
    from specmate.mechanical_sources.contracts import MechanicalSource
    from specmate.mechanical_sources.operations import evaluate

    hidden_project = op(
        users["outsider"], "project.create", {"name": "Uninterpreted board origin"}
    )["project_id"]
    original = op(
        users["outsider"],
        "definition.create",
        {"project_id": hidden_project, "kind": "board", "name": "Original board"},
    )
    hidden = op(
        users["outsider"],
        "draft.freeze",
        {"draft_id": original["draft_id"]},
        expected_state=original["state"],
    )
    target = Revision.objects.get(id=mec_target["revision_id"])
    SnapshotDependency.objects.create(snapshot=target.snapshot, revision_id=hidden["revision_id"])
    content = declaration(mec_sources, mec_target)
    content["targets"][0]["role"] = "board"
    with pytest.raises(NotFound):
        evaluate(users["editor"], target.definition, MechanicalSource.model_validate(content))


@pytest.mark.parametrize(
    "command", ["definition.create", "draft.update", "draft.snapshot", "draft.freeze"]
)
@pytest.mark.parametrize("legacy", [False, True])
def test_generic_replay_denies_retained_source_before_changed_request(
    users, project, mec_sources, mec_target, command, legacy
):
    foreign_project, original = foreign_source(users)
    Membership.objects.create(project_id=foreign_project, user=users["owner"], role="viewer")
    old = declaration(original, mec_target)
    old["sources"][0]["files"] = old["sources"][0]["files"][:1]
    payload = {
        "project_id": project,
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
    Membership.objects.filter(project_id=foreign_project, user=users["owner"]).delete()
    from .test_transports import api

    client = api(users["owner"])
    assert client.get(f"/api/v0/drafts/{created['draft_id']}").status_code == 200
    assert client.get(f"/api/v0/mechanical-sources/drafts/{created['draft_id']}").status_code == 200
    if command == "draft.freeze":
        assert client.get(f"/api/v0/revisions/{stored['revision_id']}/snapshot").status_code == 404
        assert (
            client.get(f"/api/v0/mechanical-sources/revisions/{stored['revision_id']}").status_code
            == 404
        )
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
                "project_id": project,
                "kind": "hardware",
                "name": "Unrelated incoming draft",
            },
        )
        payload["draft_id"] = unrelated["draft_id"]
    if legacy:
        from specmate.operations.models import IdempotencyRecord

        IdempotencyRecord.objects.filter(
            actor=users["owner"], operation=command, key="generic-retained"
        ).update(scope="legacy")
    # The source command's retained result still carries the old origin, even
    # when current draft and a changed request are fully readable.
    with pytest.raises(NotFound):
        op(
            users["owner"],
            command,
            payload,
            expected_state=current["state"] if command != "definition.create" else None,
            idempotency_key="generic-retained",
        )

    # With origin access restored, the same changed request may report the
    # documented key mismatch (or legacy conflict); it must never execute again.
    from specmate.operations import Conflict, IdempotencyMismatch

    Membership.objects.create(project_id=foreign_project, user=users["owner"], role="viewer")
    with pytest.raises(Conflict if legacy else IdempotencyMismatch):
        op(
            users["owner"],
            command,
            payload,
            expected_state=current["state"] if command != "definition.create" else None,
            idempotency_key="generic-retained",
        )


def test_generic_firmware_retained_source_denial_precedes_key_mismatch(users, project, board):
    from specmate.sources.models import SourceBundle

    from .test_firmware import CONFIG, MAIN
    from .test_firmware import declaration as firmware_declaration

    files = []
    for path, data in (("src/main.cpp", MAIN), ("platformio.ini", CONFIG)):
        register(users["owner"], project, data)
        files.append(
            {"path": path, "sha256": digest(data), "rights": "MIT", "media_type": "text/plain"}
        )
    original = op(
        users["owner"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Firmware retained origin", "files": files},
    )
    payload = {
        "project_id": project,
        "kind": "firmware",
        "name": "Generic firmware retained source",
        "content": {"firmware": firmware_declaration(original, board)},
    }
    created = op(users["owner"], "definition.create", payload, idempotency_key="firmware-retained")
    replacement = op(
        users["owner"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Readable firmware replacement", "files": files},
    )
    new = {"firmware": firmware_declaration(replacement, board)}
    op(
        users["owner"],
        "draft.update",
        {"draft_id": created["draft_id"], "changes": new},
        expected_state=created["state"],
    )
    hidden = op(users["outsider"], "project.create", {"name": "Revoked firmware origin"})[
        "project_id"
    ]
    SourceBundle.objects.filter(id=original["bundle_id"]).update(project_id=hidden)
    payload["content"] = new
    with pytest.raises(NotFound):
        op(users["owner"], "definition.create", payload, idempotency_key="firmware-retained")
