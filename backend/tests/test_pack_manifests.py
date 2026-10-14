"""ACC-EXT-001: authority is declared, reviewed and accepted apart from content."""

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.catalog_packs.models import PackDecision
from specmate.catalog_packs.queries import get_pack, get_version, history
from specmate.operations import ValidationFailed

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


def accept(users, version, accept_authority, state="pack-v0"):
    return op(
        users["editor"],
        "catalog_pack.install",
        {
            "pack_id": version["pack_id"],
            "version_id": version["version_id"],
            "basis": "Reviewed.",
            "accept_authority": accept_authority,
        },
        expected_state=state,
    )


def test_authority_update_is_not_accepted_as_catalog_only_update(users, project, revision):
    v1 = registered(users, project, revision)
    assert v1["authority_review"]["requires_acceptance"] is False
    installed = install(users, v1)
    assert installed["execution_authority"] == "none"

    v2 = op(
        users["editor"],
        "catalog_pack.register",
        {
            "workspace_id": workspace_of(project),
            "pack_id": v1["pack_id"],
            "manifest": {
                **v1["manifest"],
                "version": "2.0",
                "requested_authority": [NETWORK],
            },
        },
    )
    assert v2["execution_authority"] == "declared_not_granted"
    assert v2["authority_review"]["new"] == ["network_egress:api.example.test"]
    # Plain content-update acceptance is refused and names the new privilege.
    with pytest.raises(ValidationFailed) as error:
        install(users, v2, installed["state"])
    assert error.value.details["new_authority"] == ["network_egress:api.example.test"]
    # Accepting a different or broader set is refused too.
    for wrong in (["network_egress:other"], ["network_egress:api.example.test", "execution:x"]):
        with pytest.raises(ValidationFailed):
            accept(users, v2, wrong, installed["state"])
    assert get_pack(users["viewer"], v1["pack_id"])["installed_version_id"] == v1["version_id"]

    updated = accept(users, v2, ["network_egress:api.example.test"], installed["state"])
    assert updated["installed_version_id"] == v2["version_id"]
    assert updated["accepted_authority"] == ["network_egress:api.example.test"]
    assert updated["execution_authority"] == "accepted_declaration"
    rows = history(users["viewer"], v1["pack_id"])["results"]
    assert rows[-1]["accepted_authority"] == ["network_egress:api.example.test"]
    # Unchanged authority carries on without a new acceptance; downgrade to less is allowed.
    again = get_version(users["viewer"], v2["version_id"])["authority_review"]
    assert again["requires_acceptance"] is False
    back = install(users, v1, updated["state"])
    assert back["accepted_authority"] == []
    # Disable drops the baseline: re-enabling the privileged version needs acceptance again.
    op(
        users["editor"],
        "catalog_pack.disable",
        {"pack_id": v1["pack_id"], "basis": "Stop."},
        expected_state=back["state"],
    )
    assert get_version(users["viewer"], v2["version_id"])["authority_review"]["new"]


def test_adoption_still_requires_the_accepted_install(users, project, revision):
    v1 = registered(users, project, revision, requested_authority=[NETWORK])
    with pytest.raises(ValidationFailed):
        install(users, v1)
    from specmate.operations import Conflict

    with pytest.raises(Conflict):
        adopt(users, v1)


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
    assert version["publisher_status"] == "unverified_claim"
    installed = accept(users, version, ["execution:synthetic"])
    # Acceptance records a declaration; running the recipe needs the separate registry.
    assert installed["execution_authority"] == "accepted_declaration"


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
    ],
)
def test_malformed_or_forbidden_authority_is_rejected(users, project, revision, change):
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


def test_database_rejects_install_that_skips_authority_acceptance(users, project, revision):
    version = registered(users, project, revision, requested_authority=[NETWORK])
    for accepted in ([], ["network_egress:api.example.test", "execution:x"]):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO catalog_packs_packdecision (id,pack_id,version_id,sequence,action,"
                "basis,accepted_authority,decided_by_id,created_at) VALUES "
                "(gen_random_uuid(),%s,%s,1,'install','x',%s::jsonb,%s,now())",
                [
                    version["pack_id"],
                    version["version_id"],
                    __import__("json").dumps(accepted),
                    users["editor"].id,
                ],
            )
    assert not PackDecision.objects.exists()
