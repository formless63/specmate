"""Direct PostgreSQL evidence for pack graph and fresh-identity invariants."""

import hashlib
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import DatabaseError, close_old_connections, connection, transaction

from specmate.access.models import WorkspaceMember
from specmate.catalog_packs.contracts import PackManifest
from specmate.catalog_packs.models import (
    AdoptionEntry,
    PackDecision,
    PackVersion,
    VersionDependency,
)
from specmate.catalog_packs.queries import get_version
from specmate.design.models import Definition
from specmate.design.operations import canonical_bytes
from specmate.operations import NotFound

from .conftest import ensure_member, op
from .test_catalog_packs import (
    adopt,
    install,
    manifest,
    registered,
)
from .test_design import freeze
from .test_sources import ORIGINAL, files, register
from .test_workshop_profiles import create as create_profile
from .test_workshop_profiles import profile, stock_revision


@pytest.fixture
def revision(users, definition):
    return freeze(users["owner"], definition["draft_id"], definition["state"])


def raw_version(user, pack_id, revision, *, version_id=None, dependencies=(), label="raw"):
    """Exact inert manifest, deliberately bypassing service chronology for DB tests."""
    body = PackManifest.model_validate(
        manifest(revision, version=label, dependencies=list(dependencies))
    )
    canonical = canonical_bytes(body.model_dump(mode="json"))
    return PackVersion.objects.create(
        id=version_id or uuid.uuid4(),
        pack_id=pack_id,
        version=label,
        canonical=canonical,
        sha256=hashlib.sha256(canonical).hexdigest(),
        registered_by=user,
    )


def insert_dependency(version_id, dependency_id):
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO catalog_packs_versiondependency (version_id, dependency_id) "
            "VALUES (%s,%s)",
            [version_id, dependency_id],
        )


def insert_adoption(
    decision_id,
    entry_id,
    *,
    definition_id=None,
    draft_id=None,
    content=None,
    status="inert_reference",
):
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO catalog_packs_adoptionentry "
            "(decision_id,entry_id,definition_id,draft_id,initial_content,status) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            [decision_id, entry_id, definition_id, draft_id, content, status],
        )


def constraint_name(error):
    return error.value.__cause__.diag.constraint_name


def test_direct_dependency_cycle_rejected_and_older_acyclic_versions_retained(
    users, project, revision
):
    original = registered(users, project, revision)
    aid, bid, cid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    a = raw_version(
        users["owner"],
        original["pack_id"],
        revision,
        version_id=aid,
        dependencies=[bid, original["version_id"]],
        label="a",
    )
    b = raw_version(
        users["owner"], original["pack_id"], revision, version_id=bid, dependencies=[cid], label="b"
    )
    c = raw_version(
        users["owner"], original["pack_id"], revision, version_id=cid, dependencies=[aid], label="c"
    )
    insert_dependency(a.id, original["version_id"])
    insert_dependency(a.id, b.id)
    insert_dependency(b.id, c.id)
    with pytest.raises(DatabaseError) as error, transaction.atomic():
        insert_dependency(c.id, a.id)
    assert constraint_name(error) == "pack_dependency_acyclic"
    assert VersionDependency.objects.count() == 3
    assert VersionDependency.objects.filter(
        version=a, dependency_id=original["version_id"]
    ).exists()


@pytest.mark.django_db(transaction=True)
def test_competing_direct_dependency_edges_cannot_commit_a_cycle(users, project, revision):
    original = registered(users, project, revision)
    aid, bid = uuid.uuid4(), uuid.uuid4()
    raw_version(
        users["owner"], original["pack_id"], revision, version_id=aid, dependencies=[bid], label="a"
    )
    raw_version(
        users["owner"], original["pack_id"], revision, version_id=bid, dependencies=[aid], label="b"
    )
    barrier = Barrier(2)

    def competing(edge):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                with transaction.atomic():
                    insert_dependency(*edge)
                return "inserted"
            except DatabaseError as error:
                assert error.__cause__.diag.constraint_name == "pack_dependency_acyclic"
                return "cycle_rejected"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(competing, [(aid, bid), (bid, aid)])) == [
            "cycle_rejected",
            "inserted",
        ]
    assert VersionDependency.objects.count() == 1


def test_direct_reuse_of_materialized_identity_rejected_but_new_adoption_is_distinct(
    users, project, revision
):
    version = registered(users, project, revision)
    install(users, version)
    adopted = adopt(users, version)
    first = AdoptionEntry.objects.get()
    decision = PackDecision.objects.create(
        pack_id=version["pack_id"],
        version_id=version["version_id"],
        sequence=3,
        action="adopt",
        basis="Direct SQL duplicate attempt",
        decided_by=users["owner"],
    )
    with pytest.raises(DatabaseError) as error, transaction.atomic():
        insert_adoption(
            decision.id,
            first.entry_id,
            definition_id=first.definition_id,
            draft_id=first.draft_id,
            content=bytes(first.initial_content),
            status="draft_created",
        )
    assert constraint_name(error) in {"pack_adopted_definition_unique", "pack_adopted_draft_unique"}
    assert AdoptionEntry.objects.count() == 1
    # Repeated deliberate adoption is legal because it creates another fresh identity.
    adopt(users, version, "pack-v3")
    second = AdoptionEntry.objects.exclude(pk=first.pk).get()
    assert first.definition_id != second.definition_id and first.draft_id != second.draft_id
    assert adopted["state"] == "pack-v2"
    # Each of the two independent non-null unique indexes exists on the live DB.
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT indexname FROM pg_indexes WHERE tablename='catalog_packs_adoptionentry' "
            "AND indexname IN ('pack_adopted_definition_unique','pack_adopted_draft_unique')"
        )
        assert {row[0] for row in cursor.fetchall()} == {
            "pack_adopted_definition_unique",
            "pack_adopted_draft_unique",
        }


@pytest.mark.parametrize("category", ["content", "profile"])
def test_direct_engineering_entry_cannot_claim_an_inert_adoption(
    users, project, revision, category
):
    if category == "profile":
        stock_id, _ = stock_revision(users, project)
        draft = create_profile(users, project, profile(stock_id))
        revision = op(
            users["owner"],
            "workshop_profile.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )
    entries = [{**manifest(revision)["entries"][0], "category": category}]
    version = registered(users, project, revision, entries=entries)
    install(users, version)
    decision = PackDecision.objects.create(
        pack_id=version["pack_id"],
        version_id=version["version_id"],
        sequence=2,
        action="adopt",
        basis="Wrong inert status",
        decided_by=users["owner"],
    )
    entry = PackVersion.objects.get(id=version["version_id"]).entries.get()
    with pytest.raises(DatabaseError) as error, transaction.atomic():
        insert_adoption(decision.id, entry.id)
    assert constraint_name(error) == "pack_adoption_category"
    assert not AdoptionEntry.objects.exists()


@pytest.mark.parametrize("category", ["rule", "model", "recipe_reference"])
def test_direct_inert_entry_cannot_claim_a_materialized_draft(users, project, revision, category):
    register(users["owner"], project, ORIGINAL)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Inert category source", "files": files(ORIGINAL)},
    )
    entry = {"key": "part", "label": "Inert asset", "category": category, "rights": "unknown"}
    if category == "recipe_reference":
        entry["recipe"] = {"recipe_id": "synthetic.reference", "version": "1", "digest": "a" * 64}
    else:
        entry.update(
            {
                "revision_id": revision["revision_id"],
                "revision_sha256": revision["sha256"],
                "source": {
                    "source_bundle_revision_id": source["revision_id"],
                    "source_path": "src/source.txt",
                    "sha256": hashlib.sha256(ORIGINAL).hexdigest(),
                    "rights": "synthetic-original",
                },
            }
        )
    version = registered(users, project, revision, entries=[entry])
    install(users, version)
    decision = PackDecision.objects.create(
        pack_id=version["pack_id"],
        version_id=version["version_id"],
        sequence=2,
        action="adopt",
        basis="Wrong materialization status",
        decided_by=users["owner"],
    )
    item = PackVersion.objects.get(id=version["version_id"]).entries.get()
    fresh = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": Definition.objects.get(id=revision_definition(revision)).kind,
            "name": "Fresh identity",
            "content": {"a": 1},
        },
    )
    with pytest.raises(DatabaseError) as error, transaction.atomic():
        insert_adoption(
            decision.id,
            item.id,
            definition_id=fresh["definition_id"],
            draft_id=fresh["draft_id"],
            content=canonical_bytes({"a": 1}),
            status="draft_created",
        )
    assert constraint_name(error) == "pack_adoption_category"
    # Correct inert rows remain valid, including repeated NULL identities.
    insert_adoption(decision.id, item.id)
    next_decision = PackDecision.objects.create(
        pack_id=version["pack_id"],
        version_id=version["version_id"],
        sequence=3,
        action="adopt",
        basis="Second inert reference",
        decided_by=users["owner"],
    )
    insert_adoption(next_decision.id, item.id)
    assert (
        AdoptionEntry.objects.filter(definition=None, draft=None, status="inert_reference").count()
        == 2
    )


def revision_definition(revision):
    from specmate.design.models import Revision

    return Revision.objects.get(id=revision["revision_id"]).definition_id


@pytest.mark.parametrize("category", ["content", "profile", "rule", "model", "recipe_reference"])
def test_supplementary_pins_remain_authorized_even_for_inert_adoption(
    users, project, revision, category
):
    other = op(users["owner"], "project.create", {"name": "Supporting provenance"})["project_id"]
    ensure_member(users["editor"], "viewer", project=other)
    file_project = project if category in {"rule", "model"} else other
    register(users["owner"], file_project, ORIGINAL)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "project_id": file_project,
            "name": "Exact supporting file",
            "files": files(ORIGINAL, path="support/source.txt "),
        },
    )
    pin = {
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "support/source.txt ",
        "sha256": hashlib.sha256(ORIGINAL).hexdigest(),
        "rights": "synthetic-original",
    }
    entry = {
        "key": "part",
        "label": "Supported entry",
        "category": category,
        "source": pin,
        "rights": "unknown",
    }
    if category == "profile":
        stock_id, _ = stock_revision(users, project)
        draft = create_profile(users, project, profile(stock_id))
        revision = op(
            users["owner"],
            "workshop_profile.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )
    if category in {"rule", "model"}:
        draft = op(
            users["owner"],
            "definition.create",
            {"project_id": other, "kind": "part", "name": "Supplementary engineering identity"},
        )
        revision = freeze(users["owner"], draft["draft_id"], draft["state"])
    if category == "recipe_reference":
        entry["recipe"] = {"recipe_id": "synthetic.reference", "version": "1", "digest": "a" * 64}
    else:
        entry.update(
            {"revision_id": revision["revision_id"], "revision_sha256": revision["sha256"]}
        )
    version = registered(users, project, revision, entries=[entry])
    installed = install(users, version, idempotency_key="supplementary-install")
    adopt(users, version, installed["state"])
    retained = get_version(users["editor"], version["version_id"])["entries"][0]
    assert retained["source"]["source_path"] == "support/source.txt "
    assert retained["source"]["rights"] == "synthetic-original"
    WorkspaceMember.objects.filter(workspace__projects=other, user=users["editor"]).delete()
    for invoke in (
        lambda: get_version(users["editor"], version["version_id"]),
        lambda: install(users, version),
        lambda: install(users, version, idempotency_key="supplementary-install"),
    ):
        with pytest.raises(NotFound) as error:
            invoke()
        assert error.value.details == {}
