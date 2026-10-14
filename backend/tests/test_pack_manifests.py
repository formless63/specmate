"""ACC-EXT-001/002/003: content and adapters stay distinguishable, needs are declared in
plain view, admins own enable/disable, and disabling keeps history."""

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.catalog_packs.queries import get_pack, get_version, history
from specmate.operations import Conflict, PermissionDenied, ValidationFailed

from .conftest import op
from .test_catalog_packs import adopt, install, manifest, registered
from .test_catalog_packs import revision as revision
from .test_wire_stock import workspace_of

NETWORK = {"kind": "network_egress", "scope": "api.example.test", "reason": "Fetch listings."}
EXECUTE = {"kind": "execution", "scope": "synthetic", "reason": "Run a converter."}
RECIPE = {
    "key": "conv",
    "label": "Converter",
    "category": "recipe_reference",
    "recipe": {"recipe_id": "synthetic", "version": "1", "digest": "a" * 64},
    "rights": "synthetic-original",
}


def test_declared_needs_are_listed_and_installed_by_an_admin_without_extra_ceremony(
    users, project, revision
):
    v1 = registered(users, project, revision)
    assert v1["declared_needs"] == []
    installed = install(users, v1)
    assert installed["enabled_needs"] == [] and installed["kind"] == "catalog"

    v2 = op(
        users["editor"],
        "catalog_pack.register",
        {
            "workspace_id": workspace_of(project),
            "pack_id": v1["pack_id"],
            "manifest": {**v1["manifest"], "version": "2.0", "requested_authority": [NETWORK]},
        },
    )
    assert v2["declared_needs"] == ["network_egress:api.example.test"]
    assert v2["manifest"]["requested_authority"][0]["reason"] == "Fetch listings."
    # An admin enables it in one decision; the needs stay visible on the pack and decision.
    updated = install(users, v2, installed["state"])
    assert updated["installed_version_id"] == v2["version_id"]
    assert updated["enabled_needs"] == ["network_egress:api.example.test"]
    # Rollback to the earlier version is the same one-step decision.
    back = install(users, v1, updated["state"])
    assert back["enabled_needs"] == []
    assert [row["action"] for row in history(users["viewer"], v1["pack_id"])["results"]] == [
        "install",
        "install",
        "install",
    ]
    assert get_version(users["viewer"], v2["version_id"])["declared_needs"]


def test_install_and_disable_are_admin_only_and_keep_history(users, project, revision):
    version = registered(users, project, revision, requested_authority=[NETWORK])
    for name in ("viewer", "contributor", "editor"):
        with pytest.raises(PermissionDenied):
            op(
                users[name],
                "catalog_pack.install",
                {"pack_id": version["pack_id"], "version_id": version["version_id"], "basis": "x"},
                expected_state="pack-v0",
            )
    installed = install(users, version)
    adopted = adopt(users, version, installed["state"])
    with pytest.raises(PermissionDenied):
        op(
            users["editor"],
            "catalog_pack.disable",
            {"pack_id": version["pack_id"], "basis": "x"},
            expected_state=adopted["state"],
        )
    disabled = op(
        users["owner"],
        "catalog_pack.disable",
        {"pack_id": version["pack_id"], "basis": "Stop new use."},
        expected_state=adopted["state"],
    )
    assert disabled["enabled"] is False and disabled["enabled_needs"] == []
    # Future use stops; recorded decisions and adopted material remain readable.
    with pytest.raises(Conflict):
        adopt(users, version, disabled["state"])
    assert [row["action"] for row in history(users["viewer"], version["pack_id"])["results"]] == [
        "install",
        "adopt",
        "disable",
    ]
    assert get_version(users["viewer"], version["version_id"])["version_id"]
    assert get_pack(users["viewer"], version["pack_id"])["enabled"] is False


def test_adapter_manifest_declares_recipe_and_execution(users, project, revision):
    with pytest.raises(ValidationFailed):
        registered(users, project, revision, kind="adapter")
    entries = [*manifest(revision)["entries"], RECIPE]
    with pytest.raises(ValidationFailed):  # recipe but no declared execution
        registered(
            users, project, revision, kind="adapter", entries=entries, requested_authority=[NETWORK]
        )
    version = registered(
        users,
        project,
        revision,
        kind="adapter",
        entries=entries,
        requested_authority=[EXECUTE],
        compatible_contract_versions=["1", "2"],
    )
    assert version["manifest"]["kind"] == "adapter"
    assert version["compatibility"] == "supported_contract"
    assert version["declared_needs"] == ["execution:synthetic"]
    installed = install(users, version)
    # Enabling records the admin's decision; running the recipe needs the separate registry.
    assert installed["kind"] == "adapter" and installed["enabled_needs"] == ["execution:synthetic"]


def test_compatibility_requires_a_supported_declared_contract(users, project, revision):
    future = registered(users, project, revision, compatible_contract_versions=["2"])
    assert future["compatibility"] == "unsupported_contract"
    with pytest.raises(Exception, match="cannot be installed"):
        install(users, future)


@pytest.mark.parametrize(
    "change",
    [
        {"requested_authority": [{**NETWORK, "kind": "database_write"}]},
        {"requested_authority": [NETWORK, NETWORK]},
        {"requested_authority": ["network"]},
        {"compatible_contract_versions": []},
        {"kind": "plugin"},
        {"signature_claim": {"algorithm": "a", "signer": "s", "signature": "x"}},
    ],
)
def test_malformed_or_forbidden_manifest_is_rejected(users, project, revision, change):
    with pytest.raises(ValidationFailed):
        registered(users, project, revision, **change)


def test_dependencies_are_reported_with_identity_and_state(users, project, revision):
    base = registered(users, project, revision)
    dependent = op(
        users["editor"],
        "catalog_pack.register",
        {
            "workspace_id": workspace_of(project),
            "manifest": {
                **base["manifest"],
                "package_key": "synthetic.dependent",
                "dependencies": [base["version_id"]],
            },
        },
    )
    row = dependent["dependency_versions"][0]
    assert row["package_key"] == "synthetic.parts" and row["enabled"] is False
    install(users, base)
    assert get_version(users["viewer"], dependent["version_id"])["dependency_versions"][0][
        "enabled"
    ]


def test_database_rejects_manifest_with_signature_field(users, project, revision):
    version = registered(users, project, revision)
    with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO catalog_packs_packversion (id,pack_id,version,canonical,sha256,"
            "registered_by_id,created_at) "
            "SELECT gen_random_uuid(),pack_id,'9.9',"
            "convert_to((convert_from(canonical,'UTF8')::jsonb || '{\"signature_claim\":{}}'"
            "::jsonb || '{\"version\":\"9.9\"}'::jsonb)::text,'UTF8'),'0',registered_by_id,now() "
            "FROM catalog_packs_packversion WHERE id=%s",
            [version["version_id"]],
        )
