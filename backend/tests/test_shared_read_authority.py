"""Shared read closures preserve retained origins before diagnostics and disclosure."""

import copy
from uuid import UUID

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import Membership
from specmate.assemblies.queries import get_snapshot, read_assembly
from specmate.catalog_packs.models import AdoptionEntry
from specmate.design.models import Snapshot
from specmate.facts.contracts import DefinitionTarget
from specmate.facts.models import FactAssertion
from specmate.facts.queries import read_facts, resolve_target
from specmate.operations import NotFound, Unauthenticated, ValidationFailed
from specmate.queries import get_bundle_revision, get_draft

from .conftest import op
from .test_assemblies import create, freeze, occ, part
from .test_catalog_packs import adopt, install, manifest, registered
from .test_design import freeze as freeze_design
from .test_facts import append, fact, subject
from .test_firmware_builds import (  # noqa: F401
    attempt,
    board,
    firmware,
    intake,
    recipe,
    source,
    sources,
)
from .test_sources import ORIGINAL, files, register
from .test_transports import api, post_op


def adopt_with_remote_origin(users, project, original):
    """An unselected retained pack entry is current provenance, not an assembly child."""
    remote = op(users["owner"], "project.create", {"name": "Retained catalog item"})["project_id"]
    for name in ("editor", "viewer"):
        Membership.objects.create(project_id=remote, user=users[name], role="viewer")
    _, extra = part(users["owner"], remote)
    entries = manifest(original)["entries"] + [
        {
            "key": "other",
            "label": "Separate retained entry",
            "category": "content",
            "revision_id": extra["revision_id"],
            "revision_sha256": extra["sha256"],
            "rights": "synthetic-original",
        }
    ]
    version = registered(users, project, original, entries=entries)
    install(users, version)
    adopt(users, version)
    adopted = AdoptionEntry.objects.get()
    draft = get_draft(users["owner"], adopted.draft_id)
    frozen = freeze_design(users["owner"], draft["draft_id"], draft["state"])
    return remote, adopted, frozen


@pytest.fixture
def adopted_assembly(users, project):
    _, child = part(users["owner"], project)
    original = freeze(users["owner"], create(users["owner"], project, [occ("child", child)]))
    return adopt_with_remote_origin(users, project, original)


def revoke(users, project):
    Membership.objects.filter(project_id=project, user=users["viewer"]).delete()


def restore(users, project):
    Membership.objects.create(project_id=project, user=users["viewer"], role="viewer")


def test_assembly_origin_denial_precedes_path_across_jobs_and_generic_http(users, adopted_assembly):
    remote, _, frozen = adopted_assembly
    payload = {"snapshot_id": frozen["snapshot_id"]}
    client = api(users["viewer"])
    before = op(users["viewer"], "assembly.read", payload)
    assert post_op(client, "assembly.read", payload).json()["result"] == before
    raw = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    wrong = {**payload, "path": ["unresolved"]}
    with pytest.raises(NotFound, match=r"^Occurrence not found\.$"):
        op(users["viewer"], "assembly.resolve", wrong)
    revoke(users, remote)
    for operation, data in (("assembly.read", payload), ("assembly.resolve", wrong)):
        with pytest.raises(NotFound, match=r"^Project not found\.$"):
            op(users["viewer"], operation, data)
        response = post_op(client, operation, data)
        assert response.status_code == 404
        assert response.json()["error"]["message"] == "Project not found."
    restore(users, remote)
    assert op(users["viewer"], "assembly.read", payload) == before
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == raw


def test_retained_origin_precedes_wrong_snapshot_kind(users, project):
    _, original = part(users["owner"], project)
    remote, _, frozen = adopt_with_remote_origin(users, project, original)
    with pytest.raises(ValidationFailed, match="Snapshot is not an assembly"):
        get_snapshot(users["viewer"], frozen["snapshot_id"])
    revoke(users, remote)
    with pytest.raises(NotFound, match=r"^Project not found\.$"):
        get_snapshot(users["viewer"], frozen["snapshot_id"])
    restore(users, remote)
    with pytest.raises(ValidationFailed, match="Snapshot is not an assembly"):
        get_snapshot(users["viewer"], frozen["snapshot_id"])


@pytest.mark.parametrize("kind", ["definition", "occurrence"])
def test_fact_origin_denial_and_identical_restoration_across_readers(users, adopted_assembly, kind):
    remote, adopted, frozen = adopted_assembly
    target = (
        {"kind": kind, "definition_id": str(adopted.definition_id)}
        if kind == "definition"
        else {"kind": kind, "snapshot_id": frozen["snapshot_id"], "path": ["child"]}
    )
    ledger = subject(users["owner"], target)
    append(users["owner"], ledger, fact())
    payload = {"subject_id": ledger["subject_id"]}
    client = api(users["viewer"])
    url = f"/api/v0/facts/subjects/{ledger['subject_id']}"
    before = op(users["viewer"], "facts.read", payload)
    assert client.get(url).json() == before
    assert post_op(client, "facts.read", payload).json()["result"] == before
    history = copy.deepcopy(list(FactAssertion.objects.values()))
    revoke(users, remote)
    with pytest.raises(NotFound, match=r"^Project not found\.$"):
        read_facts(users["viewer"], ledger["subject_id"])
    with pytest.raises(NotFound):
        op(users["viewer"], "facts.read", payload)
    assert client.get(url).status_code == 404
    assert post_op(client, "facts.read", payload).status_code == 404
    restore(users, remote)
    assert read_facts(users["viewer"], ledger["subject_id"]) == before
    assert client.get(url).json() == before
    assert list(FactAssertion.objects.values()) == history


def test_direct_shared_readers_reject_deactivated_captured_actor(users, adopted_assembly):
    _, adopted, frozen = adopted_assembly
    actor = users["viewer"]
    target = DefinitionTarget(kind="definition", definition_id=adopted.definition_id)
    assert read_assembly(actor, frozen["snapshot_id"])
    assert resolve_target(actor, target)["definition"].id == adopted.definition_id
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    assert actor.is_active  # A caller can retain this previously fetched Django user.
    with pytest.raises(Unauthenticated, match="Actor is not active"):
        read_assembly(actor, frozen["snapshot_id"])
    with pytest.raises(Unauthenticated, match="Actor is not active"):
        resolve_target(actor, target)


def test_valid_derived_source_facts_deny_current_source_project_and_restore(users, project):
    source_project = op(users["owner"], "project.create", {"name": "Observation sources"})[
        "project_id"
    ]
    restore(users, source_project)
    register(users["owner"], source_project, ORIGINAL)
    original = op(
        users["owner"],
        "source.create_original_bundle",
        {"project_id": source_project, "name": "Original observation", "files": files(ORIGINAL)},
    )
    derived = op(
        users["owner"],
        "source.derive_bundle",
        {"source_revision_id": original["revision_id"], "name": "Derived observation"},
    )
    retained = get_bundle_revision(users["viewer"], derived["revision_id"])
    assert retained.bundle.project_id == UUID(source_project)
    assert retained.bundle.derived_from.bundle.project_id == UUID(source_project)
    source_ledger = subject(users["owner"], {"kind": "project", "project_id": project})
    source_fact = append(
        users["owner"],
        source_ledger,
        fact(
            provenance={
                "method": "source_observation",
                "evidence": [
                    {
                        "kind": "source_file",
                        "bundle_revision_id": derived["revision_id"],
                        "path": "src/source.txt",
                    }
                ],
            }
        ),
    )
    _, design = part(users["owner"], project)
    ledger = subject(users["owner"], {"kind": "revision", "revision_id": design["revision_id"]})
    append(
        users["owner"],
        ledger,
        fact(
            provenance={
                "method": "calculation",
                "formula": "x",
                "algorithm_version": "synthetic-v1",
                "evidence": [
                    {"kind": "assertion", "assertion_id": source_fact["assertion"]["assertion_id"]}
                ],
            }
        ),
    )
    before = read_facts(users["viewer"], ledger["subject_id"])
    history = copy.deepcopy(list(FactAssertion.objects.values()))
    revoke(users, source_project)
    with pytest.raises(NotFound):
        read_facts(users["viewer"], ledger["subject_id"])
    assert (
        api(users["viewer"]).get(f"/api/v0/facts/subjects/{ledger['subject_id']}").status_code
        == 404
    )
    with pytest.raises(NotFound):
        op(users["viewer"], "facts.read", {"subject_id": ledger["subject_id"]})
    restore(users, source_project)
    assert read_facts(users["viewer"], ledger["subject_id"]) == before
    assert list(FactAssertion.objects.values()) == history


def test_compiler_options_inherit_retained_context_origin_before_path_diagnostics(
    users,
    project,
    firmware,  # noqa: F811
    board,  # noqa: F811
):
    original = freeze(
        users["owner"],
        create(
            users["owner"],
            project,
            [occ("board", board[0], assignments={"firmware_revision_id": firmware["revision_id"]})],
        ),
    )
    remote, _, frozen = adopt_with_remote_origin(users, project, original)
    data = {
        "firmware_revision_id": firmware["revision_id"],
        "assembly_snapshot_id": frozen["snapshot_id"],
        "path": ["board"],
    }
    client = api(users["viewer"])
    url = f"/api/v0/firmware-builds/firmware/{firmware['revision_id']}"
    query = {"assembly_snapshot_id": frozen["snapshot_id"], "path": "board"}
    before = op(users["viewer"], "firmware_build.options", data)
    assert client.get(url, query).json() == before
    revoke(users, remote)
    with pytest.raises(NotFound, match=r"^Project not found\.$"):
        op(users["viewer"], "firmware_build.options", {**data, "path": ["unresolved"]})
    response = client.get(url, {**query, "path": "unresolved"})
    assert response.status_code == 404
    assert response.json()["error"]["message"] == "Project not found."
    assert client.get(url, query).status_code == 404
    restore(users, remote)
    assert op(users["viewer"], "firmware_build.options", data) == before
    assert client.get(url, query).json() == before
