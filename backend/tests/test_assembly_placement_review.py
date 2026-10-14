"""Independent current/retained authority regressions for placement input reads."""

import copy
from dataclasses import replace
from uuid import UUID

import pytest

from specmate.access.models import WorkspaceMember
from specmate.assemblies import placement
from specmate.catalog_packs.models import AdoptionEntry
from specmate.design.models import Draft
from specmate.operations import Context, NotFound, Unauthenticated

from .conftest import ensure_member, op
from .test_assemblies import create, freeze, occ, part
from .test_catalog_packs import adopt, install, registered
from .test_mechanical_sources import declaration, mec_sources, mec_target  # noqa: F401
from .test_sources import register
from .test_transports import api, post_op


def assert_denied(user, draft):
    with pytest.raises(NotFound):
        op(user, "assembly.placement_inputs", {"draft_id": draft["draft_id"]})
    response = post_op(api(user), "assembly.placement_inputs", {"draft_id": draft["draft_id"]})
    assert response.status_code == 404
    assert "occurrences" not in response.json() and "source-secret" not in response.content.decode()


def test_model_source_authority_is_rechecked_for_exact_repeated_contexts(
    users,
    project,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    import hashlib

    origin = op(users["owner"], "project.create", {"name": "Synthetic model source origin"})
    pid = origin["project_id"]
    ensure_member(users["viewer"], "viewer", project=pid)
    raw = b"Original opaque synthetic model; no geometry or physical qualification.\n"
    register(users["owner"], pid, raw)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "project_id": pid,
            "name": "source-secret synthetic model",
            "files": [
                {
                    "path": "body.step",
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "media_type": "application/octet-stream",
                    "rights": "CC0-1.0",
                }
            ],
        },
    )
    _, target = part(users["owner"], pid, "part")
    model = op(
        users["owner"],
        "catalog.register_representation",
        {
            "revision_id": target["revision_id"],
            "kind": "model",
            "label": "source-secret model",
            "source_bundle_revision_id": source["revision_id"],
            "source_path": "body.step",
        },
    )
    content = declaration(mec_sources, mec_target)
    content["sources"].append(
        {
            "local_id": "model",
            "source_revision_id": source["revision_id"],
            "source_manifest_sha256": source["manifest_sha256"],
            "files": [
                {
                    "path": "body.step",
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "rights": "CC0-1.0",
                    "role": "model",
                    "format": "step",
                }
            ],
        }
    )
    content["models"] = [
        {
            "local_id": "shape",
            "representation_id": model["representation_id"],
            "revision_id": target["revision_id"],
            "snapshot_sha256": target["sha256"],
            "source_local_id": "model",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "illustration",
            "basis": "Declared correspondence only",
        }
    ]
    mechanical = op(
        users["owner"],
        "mechanical_source.create",
        {
            "project_id": project,
            "name": "Synthetic exact source assembly child",
            "mechanical_source": content,
        },
    )
    frozen = op(
        users["owner"],
        "mechanical_source.freeze",
        {"draft_id": mechanical["draft_id"]},
        expected_state=mechanical["state"],
    )
    root = create(users["owner"], project, [occ("left", frozen), occ("right", frozen)])
    result = op(users["viewer"], "assembly.placement_inputs", {"draft_id": root["draft_id"]})
    assert {tuple(row["path"]) for row in result["occurrences"]} == {("left",), ("right",)}
    WorkspaceMember.objects.filter(workspace__projects=pid, user=users["viewer"]).delete()
    assert_denied(users["viewer"], root)


def test_root_catalog_adoption_origin_is_authorized_even_for_empty_current_assembly(users, project):
    origin = op(users["owner"], "project.create", {"name": "Synthetic catalog origin"})
    for name in ("editor", "viewer"):
        ensure_member(users[name], "viewer", project=origin["project_id"])
    original = freeze(users["owner"], create(users["owner"], origin["project_id"]))
    version = registered(users, project, original)
    install(users, version)
    adopt(users, version)
    entry = AdoptionEntry.objects.get(entry__version_id=version["version_id"])
    root = {"draft_id": str(entry.draft_id)}
    assert op(users["viewer"], "assembly.placement_inputs", root)["occurrences"] == []
    WorkspaceMember.objects.filter(
        workspace__projects=origin["project_id"], user=users["viewer"]
    ).delete()
    assert_denied(users["viewer"], root)


def test_retained_base_closure_is_checked_after_draft_removes_the_hidden_child(users, project):
    origin = op(users["owner"], "project.create", {"name": "Synthetic retained origin"})
    ensure_member(users["viewer"], "viewer", project=origin["project_id"])
    _, old = part(users["owner"], origin["project_id"])
    root = create(users["owner"], project, [occ("old-child", old)])
    frozen = freeze(users["owner"], root)
    current = copy.deepcopy(frozen["draft"]["content"]["assembly"])
    current["occurrences"] = []
    updated = op(
        users["owner"],
        "assembly.update",
        {"draft_id": root["draft_id"], "assembly": current},
        expected_state=frozen["draft"]["state"],
    )
    assert (
        op(users["viewer"], "assembly.placement_inputs", {"draft_id": root["draft_id"]})[
            "occurrences"
        ]
        == []
    )
    WorkspaceMember.objects.filter(
        workspace__projects=origin["project_id"], user=users["viewer"]
    ).delete()
    assert_denied(users["viewer"], root)
    assert Draft.objects.get(id=root["draft_id"]).state_token == updated["state"]


def test_direct_read_refreshes_actor_activity_instead_of_trusting_stale_context(users, project):
    root = create(users["owner"], project)
    actor = users["viewer"]
    context = Context(user=actor, via="api", request_id="read-placement")
    actor.__class__.objects.filter(pk=actor.pk).update(is_active=False)
    assert actor.is_active
    with pytest.raises(Unauthenticated):
        placement.inspect_inputs(
            replace(context), placement.PlacementInputs(draft_id=UUID(root["draft_id"]))
        )


def test_current_draft_can_drop_a_pin_but_its_original_exact_revision_read_still_denies(
    users, project
):
    origin = op(users["owner"], "project.create", {"name": "Synthetic original editor child"})
    ensure_member(users["viewer"], "viewer", project=origin["project_id"])
    _, child = part(users["owner"], origin["project_id"])
    root = create(users["owner"], project, [occ("original-child", child)])
    op(
        users["owner"],
        "assembly.update",
        {"draft_id": root["draft_id"], "assembly": {"occurrences": [], "relationships": []}},
        expected_state=root["state"],
    )
    client = api(users["viewer"])
    assert client.get(f"/api/v0/revisions/{child['revision_id']}").status_code == 200
    WorkspaceMember.objects.filter(
        workspace__projects=origin["project_id"], user=users["viewer"]
    ).delete()
    assert (
        op(users["viewer"], "assembly.placement_inputs", {"draft_id": root["draft_id"]})[
            "occurrences"
        ]
        == []
    )
    denied = client.get(f"/api/v0/revisions/{child['revision_id']}")
    assert denied.status_code == 404
    assert str(child["snapshot_id"]) not in denied.content.decode()
