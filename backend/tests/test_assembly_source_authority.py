"""An assembly's visible design pins never grant access to its children's sources."""

import hashlib
from functools import partial

import pytest
from django.test import Client

from specmate.assemblies.queries import read_assembly
from specmate.design.models import Definition, Draft, Snapshot
from specmate.operations import Context, NotFound, execute
from specmate.operations.models import IdempotencyRecord
from specmate.queries import get_draft, get_revision
from specmate.sources.models import SourceBlob, SourceBundle, SourceBundleFile, SourceBundleRevision

from .conftest import op
from .test_assemblies import create, endpoint, freeze, occ
from .test_workshop_profiles import create as create_profile
from .test_workshop_profiles import profile, stock_revision


@pytest.fixture
def sourced_child(users, project):
    stock_id, _ = stock_revision(users, project)
    raw = b"Synthetic assembly preparation instruction."
    digest = hashlib.sha256(raw).hexdigest()
    blob = SourceBlob.objects.create(
        project_id=project,
        sha256=digest,
        size=len(raw),
        media_type="text/plain",
        registered_by=users["owner"],
    )
    bundle = SourceBundle.objects.create(
        project_id=project,
        name="Synthetic instructions",
        role="original",
        created_by=users["owner"],
    )
    source_revision = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=b"{}",
        manifest_sha256=hashlib.sha256(b"{}").hexdigest(),
        created_by=users["owner"],
    )
    SourceBundleFile.objects.create(
        revision=source_revision,
        path="instructions.txt",
        blob=blob,
        media_type="text/plain",
        rights="synthetic-test",
    )
    draft = create_profile(
        users,
        project,
        profile(
            stock_id,
            foil_visibility={
                "value": "hide",
                "basis": "documented",
                "source": {
                    "kind": "source_file",
                    "bundle_revision_id": str(source_revision.id),
                    "path": "instructions.txt",
                    "sha256": digest,
                    "rights": "synthetic-test",
                },
            },
        ),
    )
    child = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    module = freeze(users["owner"], create(users["owner"], project, [occ("profile", child)]))
    hidden_project = op(users["outsider"], "project.create", {"name": "Restricted sources"})

    def revoke():
        # Trusted fixture mutation changes current source authority; immutable design
        # snapshots and their project memberships deliberately remain unchanged.
        bundle.project_id = hidden_project["project_id"]
        bundle.save(update_fields=["project"])

    return module, revoke


def assert_hidden(action):
    with pytest.raises(NotFound) as error:
        action()
    assert error.value.details == {}
    assert "profile" not in error.value.message
    assert "instructions" not in error.value.message


def test_typed_source_revocation_hides_nested_reads_and_adapter_results(
    users, project, sourced_child
):
    child, revoke = sourced_child
    root = create(users["owner"], project, [occ("module", child)])
    frozen = freeze(users["owner"], root)
    canonical = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    assert len(read_assembly(users["viewer"], frozen["snapshot_id"])["occurrences"]) == 2
    revoke()
    for read in [
        lambda: get_draft(users["owner"], root["draft_id"]),
        lambda: get_revision(users["owner"], frozen["revision_id"]),
        lambda: read_assembly(users["owner"], frozen["snapshot_id"]),
        lambda: op(
            users["owner"],
            "assembly.resolve",
            {
                "snapshot_id": frozen["snapshot_id"],
                "path": ["missing"],
            },
        ),
        lambda: execute(
            "assembly.read",
            Context(user=users["owner"], via="mcp", request_id="source-read"),
            {"snapshot_id": frozen["snapshot_id"]},
        ),
    ]:
        assert_hidden(read)
    client = Client()
    client.force_login(users["owner"])
    for path in [f"snapshots/{frozen['snapshot_id']}", f"drafts/{root['draft_id']}"]:
        response = client.get(f"/api/v0/assemblies/{path}")
        assert response.status_code == 404
        assert response.json()["error"]["details"] == {}
        assert child["revision_id"] not in response.content.decode()
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == canonical


def test_current_source_authority_precedes_stale_conflicts_and_rolls_back(
    users, project, sourced_child
):
    child, revoke = sourced_child
    root = create(users["owner"], project, [occ("module", child)])
    revoke()
    before = (Snapshot.objects.count(), IdempotencyRecord.objects.count())
    for name, payload in [
        ("assembly.update", {"draft_id": root["draft_id"], "assembly": {}}),
        ("draft.update", {"draft_id": root["draft_id"], "changes": {"assembly": {}}}),
        *[
            (name, {"draft_id": root["draft_id"]})
            for name in ("assembly.snapshot", "assembly.freeze", "draft.snapshot", "draft.freeze")
        ],
    ]:
        for state in (root["state"], "stale"):
            assert_hidden(partial(op, users["owner"], name, payload, expected_state=state))
    assert (Snapshot.objects.count(), IdempotencyRecord.objects.count()) == before
    assert Draft.objects.get(id=root["draft_id"]).state_token == root["state"]


def test_new_assembly_authorizes_sources_before_graph_diagnostics(users, project, sourced_child):
    child, revoke = sourced_child
    revoke()
    assembly = {
        "occurrences": [occ("module", child)],
        "relationships": [
            {
                "kind": "mating",
                "local_id": "unresolved",
                "a": endpoint(["module"]),
                "b": endpoint(["missing"]),
            }
        ],
    }
    before = Definition.objects.count()
    for name, payload in [
        ("assembly.create", {"project_id": project, "name": "Assembly", "assembly": assembly}),
        (
            "definition.create",
            {
                "project_id": project,
                "name": "Assembly",
                "kind": "assembly",
                "content": {"assembly": assembly},
            },
        ),
    ]:
        assert_hidden(partial(op, users["owner"], name, payload))
    assert Definition.objects.count() == before


@pytest.mark.parametrize(
    "name",
    [
        "assembly.create",
        "definition.create",
        "assembly.update",
        "draft.update",
        "assembly.snapshot",
        "draft.snapshot",
        "assembly.freeze",
        "draft.freeze",
    ],
)
def test_replay_checks_original_source_after_current_draft_removes_it(
    users, project, sourced_child, name
):
    child, revoke = sourced_child
    assembly = {"occurrences": [occ("module", child)]}
    expected = None
    if name.endswith("create"):
        payload = {"project_id": project, "name": "Retained assembly"}
        if name == "assembly.create":
            payload["assembly"] = assembly
        else:
            payload.update(kind="assembly", content={"assembly": assembly})
    else:
        root = create(users["owner"], project, assembly["occurrences"])
        payload = {"draft_id": root["draft_id"]}
        expected = root["state"]
        if name == "assembly.update":
            payload["assembly"] = assembly
        elif name == "draft.update":
            payload["changes"] = {"assembly": assembly}
    original = op(
        users["owner"], name, payload, expected_state=expected, idempotency_key="retained"
    )
    assert (
        op(users["owner"], name, payload, expected_state=expected, idempotency_key="retained")
        == original
    )
    draft_id = original.get("draft_id") or payload["draft_id"]
    current = get_draft(users["owner"], draft_id)
    op(
        users["owner"],
        "assembly.update",
        {"draft_id": draft_id, "assembly": {}},
        expected_state=current["state"],
    )
    revoke()
    assert get_draft(users["owner"], draft_id)["content"]["assembly"]["occurrences"] == []
    assert_hidden(
        lambda: op(
            users["owner"], name, payload, expected_state=expected, idempotency_key="retained"
        )
    )
