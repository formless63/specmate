"""ACC-LIB-004: deliberate inert adoption, retained versions and old consumer pins."""

import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import DatabaseError, close_old_connections, connection, transaction

from specmate.catalog_packs.authoring import origin_revisions
from specmate.catalog_packs.contracts import PackManifest
from specmate.catalog_packs.models import (
    AdoptionEntry,
    CatalogPack,
    PackDecision,
    PackVersion,
    VersionEntry,
)
from specmate.catalog_packs.queries import get_pack, get_version, history, list_packs
from specmate.design.models import Definition, Draft, Snapshot, SnapshotDependency
from specmate.design.operations import canonical_bytes
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unsupported,
    ValidationFailed,
)
from specmate.queries import get_draft, get_revision

from .conftest import member, op, remove_member
from .test_design import freeze
from .test_sources import ORIGINAL, files, register
from .test_transports import api, post_op
from .test_wire_stock import workspace_of
from .test_workshop_profiles import create as create_profile
from .test_workshop_profiles import profile, stock_revision


@pytest.fixture
def revision(users, definition):
    return freeze(users["owner"], definition["draft_id"], definition["state"])


def manifest(revision, *, version="1.0", **changes):
    return {
        "package_key": "synthetic.parts",
        "label": " Synthetic catalog ",
        "version": version,
        "publisher": "Synthetic publisher",
        "rights": " declared rights ",
        "entries": [
            {
                "key": "part",
                "label": " Adopted item ",
                "category": "content",
                "revision_id": revision["revision_id"],
                "revision_sha256": revision["sha256"],
                "rights": "synthetic-original",
            }
        ],
        **changes,
    }


def registered(users, project, revision, **changes):
    """A pack installs into the workspace library; the payload never names a project."""
    return op(
        users["editor"],
        "catalog_pack.register",
        {"workspace_id": workspace_of(project), "manifest": manifest(revision, **changes)},
        idempotency_key="register",
    )


def install(users, version, state="pack-v0", **ctx):
    return op(
        users["editor"],
        "catalog_pack.install",
        {
            "pack_id": version["pack_id"],
            "version_id": version["version_id"],
            "basis": "Reviewed inert catalog version.",
        },
        expected_state=state,
        **ctx,
    )


def adopt(users, version, state="pack-v1", **ctx):
    return op(
        users["editor"],
        "catalog_pack.adopt",
        {
            "pack_id": version["pack_id"],
            "version_id": version["version_id"],
            "entry_keys": ["part"],
            "basis": "Create a separate editable identity.",
        },
        expected_state=state,
        **ctx,
    )


def test_update_downgrade_disable_retains_owned_copies_originals_and_consumer_pins(
    users, project, definition, revision
):
    before = bytes(Snapshot.objects.get(id=revision["snapshot_id"]).canonical)
    v1 = registered(users, project, revision)
    assert v1["signature_status"] == "unsigned" and v1["publisher_status"] == "unverified_claim"
    assert v1["execution_authority"] == "none" and v1["manifest"]["rights"] == " declared rights "
    install(users, v1)
    adopted = adopt(users, v1)
    record = AdoptionEntry.objects.get()
    assert record.definition_id != Definition.objects.get(id=definition["definition_id"]).id
    draft = get_draft(users["editor"], record.draft_id)
    assert draft["content"] == {"a": 1}
    local = freeze(users["owner"], str(record.draft_id), draft["state"])
    assert {str(pin) for pin in origin_revisions(users["viewer"], record.definition)} == {
        revision["revision_id"]
    }
    assert SnapshotDependency.objects.filter(
        snapshot_id=local["snapshot_id"], revision_id=revision["revision_id"]
    ).exists()
    consumer = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace_of(project), "kind": "assembly", "name": "Pinned consumer"},
    )
    consumer_rev = freeze(
        users["owner"], consumer["draft_id"], consumer["state"], [local["revision_id"]]
    )
    v2 = op(
        users["editor"],
        "catalog_pack.register",
        {
            "workspace_id": workspace_of(project),
            "pack_id": v1["pack_id"],
            "manifest": manifest(
                revision,
                version="2.0",
                signature_claim={
                    "algorithm": "claimed",
                    "signer": "Unverified signer",
                    "signature": "opaque claim",
                },
            ),
        },
    )
    assert v2["signature_status"] == "unverified_claim"
    assert get_pack(users["viewer"], v1["pack_id"])["installed_version_id"] == v1["version_id"]
    updated = install(users, v2, adopted["state"])
    downgraded = install(users, v1, updated["state"])
    disabled = op(
        users["editor"],
        "catalog_pack.disable",
        {"pack_id": v1["pack_id"], "basis": "Stop new use; retain evidence."},
        expected_state=downgraded["state"],
    )
    assert disabled["enabled"] is False
    with pytest.raises(Conflict):
        adopt(users, v1, disabled["state"])
    assert SnapshotDependency.objects.filter(
        snapshot_id=consumer_rev["snapshot_id"], revision_id=local["revision_id"]
    ).exists()
    assert bytes(Snapshot.objects.get(id=revision["snapshot_id"]).canonical) == before
    assert get_revision(users["viewer"], local["revision_id"])
    page = history(users["viewer"], v1["pack_id"], limit=2)
    assert [row["action"] for row in page["results"]] == ["install", "adopt"]
    assert [
        row["action"]
        for row in history(users["viewer"], v1["pack_id"], after=page["next_after"])["results"]
    ] == ["install", "install", "disable"]


def test_roles_cas_replay_and_keyed_mismatch(users, project, revision):
    payload = {"workspace_id": workspace_of(project), "manifest": manifest(revision)}
    for name, error in [("viewer", PermissionDenied), ("outsider", NotFound)]:
        with pytest.raises(error):
            op(users[name], "catalog_pack.register", payload)
    version = registered(users, project, revision)
    assert (
        op(users["editor"], "catalog_pack.register", payload, idempotency_key="register") == version
    )
    installed = install(users, version, idempotency_key="install")
    assert install(users, version, idempotency_key="install") == installed
    with pytest.raises(Conflict):
        install(users, version)
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "catalog_pack.register",
            {**payload, "manifest": manifest(revision, version="2.0")},
            idempotency_key="register",
        )
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "catalog_pack.install",
            {
                "pack_id": version["pack_id"],
                "version_id": version["version_id"],
                "basis": "Missing state",
            },
        )


@pytest.mark.parametrize(
    "change",
    [
        {"requested_authority": ["network"]},
        {"execute": "script"},
        {
            "entries": [
                {"key": "code", "label": "Executable", "category": "code", "rights": "unknown"}
            ]
        },
    ],
)
def test_executable_or_privileged_manifest_rejected(users, project, revision, change):
    with pytest.raises(ValidationFailed):
        registered(users, project, revision, **change)
    assert not CatalogPack.objects.exists()


def test_unsupported_contract_can_be_inspected_but_not_installed(users, project, revision):
    version = registered(users, project, revision, contract_version="future")
    assert (
        get_version(users["viewer"], version["version_id"])["compatibility"]
        == "unsupported_contract"
    )
    with pytest.raises(Unsupported):
        install(users, version)
    assert not PackDecision.objects.exists()


def test_inert_rule_model_and_recipe_references_do_not_execute(users, project, revision, settings):
    register(users["owner"], project, ORIGINAL)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Inert sources",
            "files": files(ORIGINAL, path="assets/model.step "),
        },
    )
    pin = {
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "assets/model.step ",
        "sha256": hashlib.sha256(ORIGINAL).hexdigest(),
        "rights": "synthetic-original",
    }
    items = [
        {
            "key": category,
            "label": category,
            "category": category,
            "source": pin,
            "rights": "unreviewed",
        }
        for category in ("rule", "model")
    ]
    items.append(
        {
            "key": "recipe",
            "label": "Recipe reference",
            "category": "recipe_reference",
            "recipe": {"recipe_id": "synthetic.reference", "version": "1", "digest": "a" * 64},
            "rights": "unknown",
        }
    )
    version = registered(users, project, revision, entries=items)
    install(users, version)
    original_recipes = dict(settings.SPECMATE_APPROVED_RECIPES)
    op(
        users["editor"],
        "catalog_pack.adopt",
        {
            "pack_id": version["pack_id"],
            "version_id": version["version_id"],
            "entry_keys": ["rule", "model", "recipe"],
            "basis": "Keep exact inert references.",
        },
        expected_state="pack-v1",
    )
    assert settings.SPECMATE_APPROVED_RECIPES == original_recipes
    assert {row.status for row in AdoptionEntry.objects.all()} == {"inert_reference"}
    assert not AdoptionEntry.objects.exclude(definition=None).exists()
    assert (
        get_version(users["viewer"], version["version_id"])["manifest"]["entries"][0]["source"][
            "source_path"
        ]
        == "assets/model.step "
    )


def test_all_retained_source_versions_current_before_reads_conflicts_and_replay(
    users, project, revision
):
    # A source revision created from another project is ordinary same-workspace content.
    other = op(users["owner"], "project.create", {"name": "Shared source library"})["project_id"]
    source = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace_of(other), "kind": "part", "name": "Library source"},
    )
    shared = freeze(users["owner"], source["draft_id"], source["state"])
    v1 = registered(users, project, shared)
    install(users, v1, idempotency_key="install")
    v2 = op(
        users["editor"],
        "catalog_pack.register",
        {"pack_id": v1["pack_id"], "manifest": manifest(revision, version="2.0")},
    )
    assert get_version(users["viewer"], v2["version_id"])["version_id"] == v2["version_id"]
    assert [row["pack_id"] for row in list_packs(users["viewer"])["results"]] == [v1["pack_id"]]
    # Losing workspace membership hides every read, conflict and keyed replay alike.
    remove_member(users["editor"])
    for invoke in (
        lambda: get_version(users["editor"], v2["version_id"]),
        lambda: history(users["editor"], v1["pack_id"]),
        lambda: install(users, v1),
        lambda: install(users, v1, idempotency_key="install"),
        lambda: op(
            users["editor"],
            "catalog_pack.register",
            {"workspace_id": workspace_of(project), "manifest": manifest(revision)},
            idempotency_key="register",
        ),
        lambda: list_packs(users["editor"], workspace_of(project)),
        lambda: list_packs(users["editor"], workspace_of(project), after=v1["pack_id"]),
    ):
        with pytest.raises(NotFound) as error:
            invoke()
        assert error.value.details == {}


def test_contributor_imports_packs_but_installation_needs_edit(users, project, revision):
    version = op(
        users["contributor"],
        "catalog_pack.register",
        {"manifest": manifest(revision)},
    )
    with pytest.raises(PermissionDenied):
        op(
            users["contributor"],
            "catalog_pack.install",
            {"pack_id": version["pack_id"], "version_id": version["version_id"], "basis": "No"},
            expected_state="pack-v0",
        )
    assert install(users, version)["enabled"] is True


def test_pack_registration_rejects_foreign_workspace_pins_as_not_found(
    users, project, revision, other_workspace
):
    member(users["editor"], "editor", workspace=other_workspace)
    foreign = op(
        users["editor"],
        "definition.create",
        {"workspace_id": other_workspace, "kind": "part", "name": "Foreign source"},
    )
    pinned = freeze(users["outsider"], foreign["draft_id"], foreign["state"])
    # Even an actor who can read both workspaces gets the uniform NotFound.
    with pytest.raises(NotFound) as error:
        registered(users, project, pinned)
    assert error.value.message == "Not found."
    foreign_pack = op(
        users["editor"],
        "catalog_pack.register",
        {"workspace_id": other_workspace, "manifest": manifest(pinned)},
    )
    with pytest.raises(NotFound):
        registered(users, project, revision, dependencies=[foreign_pack["version_id"]])
    assert CatalogPack.objects.count() == 1 and VersionEntry.objects.count() == 1


def test_optional_registered_manifest_checks_actual_bytes_and_preserves_rights(
    users, project, revision
):
    body = PackManifest.model_validate(manifest(revision))
    raw = canonical_bytes(body.model_dump(mode="json"))
    register(users["owner"], project, raw)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Pack manifest",
            "files": files(raw, path="packs/catalog.json "),
        },
    )
    pin = {
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "packs/catalog.json ",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "rights": "synthetic-original",
    }
    result = op(
        users["editor"],
        "catalog_pack.register",
        {
            "workspace_id": workspace_of(project),
            "manifest": manifest(revision),
            "manifest_source": pin,
        },
    )
    assert result["sha256"] == hashlib.sha256(raw).hexdigest()
    assert result["manifest_source"]["source_path"] == pin["source_path"]
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "catalog_pack.register",
            {
                "workspace_id": workspace_of(project),
                "pack_id": result["pack_id"],
                "manifest": manifest(revision, version="2.0"),
                "manifest_source": pin,
            },
        )
    assert PackVersion.objects.count() == 1


def test_api_adapter_read_and_install_and_scoped_cursor(users, project, revision):
    response = post_op(
        api(users["editor"]),
        "catalog_pack.register",
        {"manifest": manifest(revision)},
    )
    assert response.status_code == 200
    version = response.json()["result"]
    url = f"/api/v0/catalog-packs/packs/{version['pack_id']}"
    assert api(users["viewer"]).get(url).json()["enabled"] is False
    assert api(users["outsider"]).get(url).status_code == 404
    assert api().get(url).status_code == 401
    assert (
        post_op(
            api(users["viewer"]),
            "catalog_pack.install",
            {"pack_id": version["pack_id"], "version_id": version["version_id"], "basis": "Denied"},
            expected_state="pack-v0",
        ).status_code
        == 403
    )


def test_source_selector_adapter_preserves_exact_files_and_current_scope(users, project):
    register(users["owner"], project, ORIGINAL)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Pack sources",
            "files": files(ORIGINAL, path="models/source.step "),
        },
    )
    url = "/api/v0/catalog-packs/source-files"
    page = api(users["viewer"]).get(url).json()
    assert page["workspace_id"] == workspace_of(project)
    assert page["results"][0]["source_path"] == "models/source.step "
    assert page["results"][0]["source_bundle_revision_id"] == source["revision_id"]
    cursor = page["results"][0]["file_id"]
    assert api(users["viewer"]).get(url + f"?after={cursor}").json()["results"] == []
    assert api(users["viewer"]).get(url + "?after=0").status_code == 404
    # The outsider sees only their own (empty) workspace and cannot name this one.
    assert api(users["outsider"]).get(url).json()["results"] == []
    scoped = f"{url}?workspace_id={workspace_of(project)}"
    assert api(users["outsider"]).get(scoped).status_code == 404
    assert api().get(url).status_code == 401


@pytest.mark.parametrize(
    "table",
    [
        "catalog_packs_catalogpack",
        "catalog_packs_packversion",
        "catalog_packs_versionentry",
        "catalog_packs_packdecision",
        "catalog_packs_adoptionentry",
    ],
)
def test_database_immutability_and_pin_sequence_consistency(users, project, revision, table):
    version = registered(users, project, revision)
    install(users, version)
    adopt(users, version)
    for sql in (f"UPDATE {table} SET id=id", f"DELETE FROM {table}"):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql)
    with pytest.raises(DatabaseError), transaction.atomic():
        PackDecision.objects.create(
            pack_id=version["pack_id"],
            version_id=version["version_id"],
            sequence=4,
            action="install",
            basis="Gap",
            decided_by=users["owner"],
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        VersionEntry.objects.create(version_id=version["version_id"], key="undeclared")


@pytest.mark.django_db(transaction=True)
def test_competing_adoptions_create_one_complete_batch(users, project, revision):
    version = registered(users, project, revision)
    install(users, version)
    barrier = Barrier(2)

    def compete():
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                adopt(users, version)
                return "created"
            except Conflict:
                return "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: compete(), range(2))) == ["conflict", "created"]
    assert AdoptionEntry.objects.count() == 1
    assert Draft.objects.count() == 2


def test_same_project_profile_copy_freezes_normal_typed_closure_plus_origin(
    users, project, revision
):
    stock_id, _ = stock_revision(users, project)
    source_draft = create_profile(users, project, profile(stock_id))
    source = op(
        users["owner"],
        "workshop_profile.freeze",
        {"draft_id": source_draft["draft_id"]},
        expected_state=source_draft["state"],
    )
    exact = get_revision(users["owner"], source["revision_id"])
    entry = {
        "key": "part",
        "label": "Copied preparation profile",
        "category": "profile",
        "revision_id": str(exact.id),
        "revision_sha256": exact.snapshot.sha256,
        "rights": "synthetic-original",
    }
    version = registered(users, project, revision, entries=[entry])
    install(users, version)
    adopt(users, version)
    copied = AdoptionEntry.objects.get()
    local = op(
        users["owner"],
        "workshop_profile.freeze",
        {"draft_id": str(copied.draft_id)},
        expected_state=get_draft(users["owner"], copied.draft_id)["state"],
    )
    assert set(
        SnapshotDependency.objects.filter(snapshot_id=local["snapshot_id"]).values_list(
            "revision_id", flat=True
        )
    ) == set(origin_revisions(users["owner"], copied.definition))
    assert (
        get_draft(users["owner"], copied.draft_id)["content"]
        == get_draft(users["owner"], source_draft["draft_id"])["content"]
    )


def test_typed_copy_from_another_project_is_same_workspace_reuse(users, project, revision):
    other = op(users["owner"], "project.create", {"name": "Typed source library"})["project_id"]
    stock_id, _ = stock_revision(users, other)
    source_draft = create_profile(users, other, profile(stock_id))
    source = op(
        users["owner"],
        "workshop_profile.freeze",
        {"draft_id": source_draft["draft_id"]},
        expected_state=source_draft["state"],
    )
    exact = get_revision(users["owner"], source["revision_id"])
    items = manifest(revision)["entries"] + [
        {
            "key": "library-profile",
            "label": "Source profile",
            "category": "profile",
            "revision_id": str(exact.id),
            "revision_sha256": exact.snapshot.sha256,
            "rights": "synthetic-original",
        }
    ]
    version = registered(users, project, revision, entries=items)
    installed = install(users, version)
    before = Definition.objects.count()
    op(
        users["editor"],
        "catalog_pack.adopt",
        {
            "pack_id": version["pack_id"],
            "version_id": version["version_id"],
            "entry_keys": ["part", "library-profile"],
            "basis": "Atomic batch",
        },
        expected_state=installed["state"],
    )
    assert Definition.objects.count() == before + 2
    assert AdoptionEntry.objects.filter(status="draft_created").count() == 2
    copied = AdoptionEntry.objects.get(entry__key="library-profile")
    assert copied.definition.workspace_id == exact.definition.workspace_id
    assert copied.definition_id != exact.definition_id


def test_later_edit_of_adopted_copy_keeps_version_and_initial_history(users, project, revision):
    source_draft = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Source assembly",
            "assembly": {"occurrences": []},
        },
    )
    revision = freeze(users["owner"], source_draft["draft_id"], source_draft["state"])
    version = registered(users, project, revision)
    install(users, version)
    adopt(users, version)
    copied = AdoptionEntry.objects.get()
    other = op(users["owner"], "project.create", {"name": "Later consumer content"})["project_id"]
    dependency = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace_of(other), "kind": "part", "name": "Library child"},
    )
    child = freeze(users["owner"], dependency["draft_id"], dependency["state"])
    draft = get_draft(users["owner"], copied.draft_id)
    op(
        users["owner"],
        "draft.update",
        {
            "draft_id": str(copied.draft_id),
            "changes": {
                "assembly": {
                    "occurrences": [
                        {"local_id": "library-child", "revision_id": child["revision_id"]}
                    ]
                }
            },
        },
        expected_state=draft["state"],
    )
    assert (
        get_version(users["editor"], version["version_id"])["version_id"] == version["version_id"]
    )
    adoptions = history(users["viewer"], version["pack_id"])["results"][1]["adoptions"]
    assert [a["draft_id"] for a in adoptions] == [str(copied.draft_id)]
    assert adoptions[0]["initial_content"]["assembly"]["occurrences"] == []


def test_nested_origin_bounds_and_cleanup_after_failure(users, project, revision, monkeypatch):
    from specmate.catalog_packs import authoring

    v1 = registered(users, project, revision)
    install(users, v1)
    adopt(users, v1)
    first = AdoptionEntry.objects.get()
    frozen = freeze(
        users["owner"], str(first.draft_id), get_draft(users["owner"], first.draft_id)["state"]
    )
    v2 = op(
        users["editor"],
        "catalog_pack.register",
        {
            "workspace_id": workspace_of(project),
            "pack_id": v1["pack_id"],
            "manifest": manifest(frozen, version="2.0"),
        },
    )
    current = install(users, v2, "pack-v2")
    adopt(users, v2, current["state"])
    second = AdoptionEntry.objects.exclude(pk=first.pk).get()
    assert frozen["revision_id"] in {
        str(pin) for pin in authoring.origin_revisions(users["owner"], second.definition)
    }
    monkeypatch.setattr(authoring, "MAX_ORIGIN_DEPTH", 1)
    with pytest.raises(ValidationFailed, match="depth"):
        authoring.origin_revisions(users["owner"], second.definition)
    assert authoring._origin_path.get() == () and authoring._origin_records.get() is None
    monkeypatch.setattr(authoring, "MAX_ORIGIN_DEPTH", 32)
    monkeypatch.setattr(authoring, "MAX_ORIGIN_RECORDS", 1)
    with pytest.raises(ValidationFailed, match="record bound"):
        authoring.origin_revisions(users["owner"], second.definition)
    assert authoring._origin_path.get() == () and authoring._origin_records.get() is None
    monkeypatch.setattr(authoring, "MAX_ORIGIN_RECORDS", 2000)
    assert authoring.origin_revisions(users["owner"], second.definition)


def test_exact_origin_cycle_guard_resets_after_malformed_traversal(
    users, project, revision, monkeypatch
):
    from specmate.catalog_packs import authoring

    version = registered(users, project, revision)
    install(users, version)
    adopt(users, version)
    adopted = AdoptionEntry.objects.get()
    real = authoring.version_closure
    monkeypatch.setattr(
        authoring,
        "version_closure",
        lambda user, versions: authoring.origin_revisions(user, adopted.definition),
    )
    with pytest.raises(ValidationFailed, match="cycle"):
        authoring.origin_revisions(users["owner"], adopted.definition)
    assert authoring._origin_path.get() == () and authoring._origin_records.get() is None
    monkeypatch.setattr(authoring, "version_closure", real)
    assert authoring.origin_revisions(users["owner"], adopted.definition)


@pytest.mark.parametrize("error", [NotFound, PermissionDenied])
def test_copy_preflight_retains_current_authorization_failure(
    users, project, revision, monkeypatch, error
):
    from specmate.catalog_packs import operations

    version = registered(users, project, revision)
    install(users, version)

    def deny(*args):
        raise error("Current copy authority changed.")

    monkeypatch.setattr(operations, "authorize_design_content", deny)
    with pytest.raises(error):
        adopt(users, version)
    assert not AdoptionEntry.objects.exists() and PackDecision.objects.count() == 1
