"""KNW-001: one knowledge identity referenced by several exact engineering objects."""

import json

import pytest
from django.db import DatabaseError, transaction

from specmate.access.models import Project
from specmate.design.models import Snapshot
from specmate.knowledge.models import (
    KnowledgeAttachment,
    KnowledgeEntry,
    KnowledgeItem,
    KnowledgeLink,
)
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob, SourceBundleFile

from .conftest import op, remove_member, set_role
from .scope_helpers import workspace_of
from .test_physical_units import unit_payload
from .test_sources import register, sha
from .test_transports import api, post_op

PHOTO = b"\x89PNG synthetic bench photo bytes\n"
SHEET = b"%PDF-1.4 synthetic datasheet bytes\n"


def preserve(user, project, name, data, path, media_type, rights="synthetic-original"):
    register(user, project, data)
    return op(
        user,
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": name,
            "files": [
                {"path": path, "sha256": sha(data), "media_type": media_type, "rights": rights}
            ],
        },
    )


def part(user, project, name):
    draft = op(user, "definition.create", {"project_id": project, "kind": "part", "name": name})
    first = op(user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"])
    second = op(
        user,
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=first["draft"]["state"],
    )
    return draft, first, second


@pytest.fixture
def world(users, project):
    owner = users["owner"]
    photo = preserve(owner, project, "Bench photos", PHOTO, "photos/joint.png", "image/png")
    sheet = preserve(owner, project, "Datasheets", SHEET, "docs/sheet.pdf", "application/pdf")
    draft, r1, r2 = part(owner, project, "Synthetic bracket")
    assembly = op(
        owner,
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic frame",
            "assembly": {
                "occurrences": [
                    {"local_id": side, "revision_id": r1["revision_id"], "display_ref": "B1"}
                    for side in ("left", "right")
                ]
            },
        },
    )
    frozen = op(
        owner,
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    units = [
        op(
            owner,
            "physical_units.register",
            unit_payload(r1["revision_id"], serial),
            idempotency_key=f"unit-{serial}",
        )
        for serial in ("SYN-001", "SYN-002")
    ]
    targets = {
        "definition": {"kind": "definition", "definition_id": draft["definition_id"]},
        "r1": {"kind": "revision", "revision_id": r1["revision_id"]},
        "r2": {"kind": "revision", "revision_id": r2["revision_id"]},
        "left": {"kind": "occurrence", "snapshot_id": frozen["snapshot_id"], "path": ["left"]},
        "right": {"kind": "occurrence", "snapshot_id": frozen["snapshot_id"], "path": ["right"]},
        "unit1": {"kind": "physical_unit", "unit_id": units[0]["unit_id"]},
        "unit2": {"kind": "physical_unit", "unit_id": units[1]["unit_id"]},
        "project": {"kind": "project", "project_id": project},
    }
    return {"photo": photo, "sheet": sheet, "targets": targets, "r1": r1}


def attachment_ref(bundle, path, label=""):
    return {"bundle_revision_id": bundle["revision_id"], "path": path, "label": label}


def create(user, project, kind="attachment", links=(), key=None, **content):
    """Create a project-held item (``project`` is the holding project)."""
    body = {"title": "Joint photo", **content}
    workspace = str(Project.objects.get(id=project).workspace_id)
    return op(
        user,
        "knowledge.create",
        {
            "workspace_id": workspace,
            "project_id": project,
            "kind": kind,
            "content": body,
            "links": list(links),
        },
        idempotency_key=key,
    )


def create_library(user, workspace, kind="note", links=(), key=None, **content):
    """Create a library note: held by the workspace, by no project."""
    body = {"title": "Library note", "body": "Synthetic.", **content}
    return op(
        user,
        "knowledge.create",
        {"workspace_id": workspace, "kind": kind, "content": body, "links": list(links)},
        idempotency_key=key,
    )


def for_target(user, target):
    return op(user, "knowledge.for_target", {"target": target})


def test_one_attachment_is_referenced_by_several_exact_objects_with_one_identity_and_blob(
    users, project, world, workspace
):
    t = world["targets"]
    linked = [t["definition"], t["r1"], t["left"], t["unit1"]]
    item = create(
        users["editor"],
        project,
        links=linked,
        attachments=[attachment_ref(world["photo"], "photos/joint.png", "joint")],
    )
    assert len(item["links"]) == 4
    assert {link["target"]["kind"] for link in item["links"]} == {
        "definition",
        "revision",
        "occurrence",
        "physical_unit",
    }
    assert KnowledgeItem.objects.count() == 1
    assert SourceBlob.objects.filter(workspace_id=workspace, sha256=sha(PHOTO)).count() == 1
    file = SourceBundleFile.objects.get(revision_id=world["photo"]["revision_id"])
    assert KnowledgeAttachment.objects.filter(source_file=file).count() == 1
    attachment = item["current"]["attachments"][0]
    assert attachment["sha256"] == sha(PHOTO)
    assert attachment["rights"] == "synthetic-original"
    assert attachment["media_type"] == "image/png"
    assert attachment["blob_workspace_id"] == workspace
    for target in linked:
        listed = for_target(users["viewer"], target)
        assert [row["item_id"] for row in listed["items"]] == [item["item_id"]]
    # Exact revision, occurrence and unit identities are distinct targets.
    for target in (t["r2"], t["right"], t["unit2"], t["project"]):
        assert for_target(users["viewer"], target)["items"] == []
    labels = {link["target"]["kind"]: link["label"] for link in item["links"]}
    assert labels["revision"] == "Synthetic bracket revision 1"
    assert labels["occurrence"] == "Synthetic frame / left"
    assert labels["physical_unit"] == "Unit SYN-001"

    # A second item reusing the same registered file adds no blob ownership.
    other = create(
        users["editor"],
        project,
        kind="note",
        title="Rework reminder",
        body="Synthetic note.",
        attachments=[attachment_ref(world["photo"], "photos/joint.png")],
        links=[t["right"]],
    )
    assert SourceBlob.objects.filter(workspace_id=workspace, sha256=sha(PHOTO)).count() == 1
    assert KnowledgeAttachment.objects.filter(source_file=file).count() == 2
    assert [r["item_id"] for r in for_target(users["viewer"], t["right"])["items"]] == [
        other["item_id"]
    ]


def test_relinking_the_same_exact_target_keeps_one_active_link(users, project, world):
    t = world["targets"]
    item = create(users["editor"], project, kind="note", body="Synthetic.", links=[t["r1"]])
    again = op(users["editor"], "knowledge.link", {"item_id": item["item_id"], "target": t["r1"]})
    assert again["created"] is False
    assert again["link_id"] == item["links"][0]["link_id"]
    feature = op(
        users["editor"],
        "knowledge.link",
        {"item_id": item["item_id"], "target": {**t["r1"], "feature_id": "hole-a"}},
    )
    assert feature["created"] is True and feature["feature_status"] == "not_evaluated"
    existing = KnowledgeLink.objects.get(id=item["links"][0]["link_id"])
    with pytest.raises(DatabaseError), transaction.atomic():
        existing.pk = None
        existing.id = None
        existing.save(force_insert=True)


def test_unlink_retains_item_attachment_other_links_and_history(
    users, project, world, artifact_root
):
    t = world["targets"]
    item = create(
        users["editor"],
        project,
        links=[t["r1"], t["left"], t["unit1"]],
        attachments=[attachment_ref(world["photo"], "photos/joint.png")],
    )
    by_kind = {link["target"]["kind"]: link for link in item["links"]}
    removed = op(
        users["editor"],
        "knowledge.unlink",
        {"link_id": by_kind["revision"]["link_id"], "reason": "Applies to the unit only."},
    )
    assert removed["status"] == "removed"
    assert for_target(users["viewer"], t["r1"])["items"] == []
    for target in (t["left"], t["unit1"]):
        assert [r["item_id"] for r in for_target(users["viewer"], target)["items"]] == [
            item["item_id"]
        ]
    read = op(users["viewer"], "knowledge.read", {"item_id": item["item_id"]})
    assert {link["target"]["kind"] for link in read["links"]} == {"occurrence", "physical_unit"}
    assert read["removed_links"][0]["removal_reason"] == "Applies to the unit only."
    assert read["current"]["attachments"][0]["sha256"] == sha(PHOTO)
    assert blobstore.blob_path(sha(PHOTO)).read_bytes() == PHOTO
    assert SourceBundleFile.objects.filter(revision_id=world["photo"]["revision_id"]).exists()
    with pytest.raises(Conflict):
        op(users["editor"], "knowledge.unlink", {"link_id": by_kind["revision"]["link_id"]})
    relinked = op(
        users["editor"], "knowledge.link", {"item_id": item["item_id"], "target": t["r1"]}
    )
    assert relinked["created"] is True
    assert relinked["link_id"] != by_kind["revision"]["link_id"]
    read = op(users["viewer"], "knowledge.read", {"item_id": item["item_id"]})
    assert len(read["links"]) == 3 and len(read["removed_links"]) == 1


def test_revisions_append_history_conflict_when_stale_and_leave_frozen_design_unchanged(
    users, project, world
):
    t = world["targets"]
    before = Snapshot.objects.get(revision__id=world["r1"]["revision_id"]).sha256
    decision = create(
        users["editor"],
        project,
        kind="decision",
        title="Bracket finish",
        body="Use the synthetic coating.",
        decision_status="proposed",
        links=[t["r1"]],
    )
    revised = op(
        users["editor"],
        "knowledge.revise",
        {
            "item_id": decision["item_id"],
            "content": {
                "title": "Bracket finish",
                "body": "Accepted after synthetic review.",
                "decision_status": "accepted",
                "attachments": [attachment_ref(world["sheet"], "docs/sheet.pdf")],
            },
        },
        expected_state=decision["state"],
    )
    assert revised["state"] == "knowledge-v2"
    assert [e["decision_status"] for e in revised["history"]] == ["proposed", "accepted"]
    assert revised["history"][0]["attachments"] == []
    assert revised["item_id"] == decision["item_id"]
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "knowledge.revise",
            {
                "item_id": decision["item_id"],
                "content": {"title": "x", "decision_status": "rejected"},
            },
            expected_state=decision["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "knowledge.revise",
            {"item_id": decision["item_id"], "content": {"title": "No status"}},
            expected_state=revised["state"],
        )
    with pytest.raises(ValidationFailed):
        create(users["editor"], project, kind="attachment", title="Nothing attached")
    with pytest.raises(ValidationFailed):
        create(users["editor"], project, kind="note", title="Empty", decision_status="accepted")
    assert Snapshot.objects.get(revision__id=world["r1"]["revision_id"]).sha256 == before
    assert KnowledgeEntry.objects.filter(item_id=decision["item_id"]).count() == 2


def test_scoped_denial_hides_foreign_workspace_targets_and_unauthorized_actors(
    users, project, world, other_workspace, workspace
):
    t = world["targets"]
    foreign_project = op(users["outsider"], "project.create", {"name": "Foreign synthetic"})[
        "project_id"
    ]
    hidden_draft, hidden_r1, _ = part(users["outsider"], foreign_project, "Hidden enclosure")
    hidden_target = {"kind": "revision", "revision_id": hidden_r1["revision_id"]}
    hidden_photo = preserve(
        users["outsider"],
        foreign_project,
        "Hidden photos",
        b"hidden synthetic bytes",
        "h.png",
        "image/png",
    )
    # A target of another workspace is simply not found, even for an administrator.
    with pytest.raises(NotFound):
        create(users["owner"], project, kind="note", body="Fit.", links=[t["r1"], hidden_target])
    assert KnowledgeItem.objects.count() == 0
    item = create(
        users["owner"], project, kind="note", title="Shared fit note", body="Fit.", links=[t["r1"]]
    )
    text = json.dumps(op(users["viewer"], "knowledge.read", {"item_id": item["item_id"]}))
    for secret in ("Hidden", hidden_r1["revision_id"], hidden_draft["definition_id"]):
        assert secret not in text
    with pytest.raises(NotFound):
        for_target(users["viewer"], hidden_target)
    # A member of only the foreign workspace sees neither the item nor a count of it.
    assert for_target(users["outsider"], hidden_target)["items"] == []
    with pytest.raises(NotFound):
        op(users["outsider"], "knowledge.read", {"item_id": item["item_id"]})
    with pytest.raises(NotFound):
        op(users["editor"], "knowledge.link", {"item_id": item["item_id"], "target": hidden_target})
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "knowledge.link", {"item_id": item["item_id"], "target": t["r2"]})
    with pytest.raises(PermissionDenied):
        create(users["viewer"], project, kind="note", body="Denied.")
    with pytest.raises(NotFound):
        create(users["owner"], project, attachments=[attachment_ref(hidden_photo, "h.png")])
    with pytest.raises(NotFound):
        create(users["editor"], project, attachments=[attachment_ref(hidden_photo, "h.png")])

    remove_member(users["viewer"])
    with pytest.raises(NotFound):
        op(users["viewer"], "knowledge.read", {"item_id": item["item_id"]})


def test_contributors_create_and_edit_only_their_own_notes_and_project_context_is_checked(
    users, workspace, other_workspace, project, world
):
    t = world["targets"]
    mine = create_library(users["contributor"], workspace, links=[t["r1"]])
    revised = op(
        users["contributor"],
        "knowledge.revise",
        {"item_id": mine["item_id"], "content": {"title": "Mine", "body": "Revised."}},
        expected_state=mine["state"],
    )
    assert revised["current"]["number"] == 2 and revised["project_id"] is None
    theirs = create_library(users["editor"], workspace, title="Editor note")
    with pytest.raises(PermissionDenied):
        op(
            users["contributor"],
            "knowledge.revise",
            {"item_id": theirs["item_id"], "content": {"title": "No", "body": "No."}},
            expected_state=theirs["state"],
        )
    with pytest.raises(PermissionDenied):
        op(
            users["contributor"],
            "knowledge.link",
            {"item_id": theirs["item_id"], "target": t["r2"]},
        )
    # Editors edit any note; viewers create nothing.
    op(users["editor"], "knowledge.link", {"item_id": mine["item_id"], "target": t["r2"]})
    with pytest.raises(PermissionDenied):
        create_library(users["viewer"], workspace)
    # A project of another workspace is not a valid context; nobody learns it exists.
    foreign_project = op(users["outsider"], "project.create", {"name": "Foreign"})["project_id"]
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "knowledge.create",
            {
                "workspace_id": workspace,
                "project_id": foreign_project,
                "kind": "note",
                "content": {"title": "x", "body": "y"},
            },
        )
    with pytest.raises(NotFound):
        create_library(users["outsider"], workspace)


def test_workspace_listing_filters_by_project_context(users, workspace, project, world):
    held = create(users["editor"], project, kind="note", body="Held by the project.")
    library = create_library(users["editor"], workspace)
    everything = op(users["viewer"], "knowledge.list", {"workspace_id": workspace})
    assert {r["item_id"] for r in everything["items"]} == {held["item_id"], library["item_id"]}
    assert everything["workspace_id"] == workspace and everything["project_id"] is None
    only = op(users["viewer"], "knowledge.list", {"workspace_id": workspace, "project_id": project})
    assert [r["item_id"] for r in only["items"]] == [held["item_id"]]
    assert only["items"][0]["project_id"] == project
    with pytest.raises(NotFound):
        op(users["outsider"], "knowledge.list", {"workspace_id": workspace})


def test_database_preserves_entries_attachments_and_link_history(users, project, world):
    t = world["targets"]
    item = create(
        users["editor"],
        project,
        links=[t["r1"]],
        attachments=[attachment_ref(world["photo"], "photos/joint.png")],
    )
    entry = KnowledgeEntry.objects.get(item_id=item["item_id"])
    link = KnowledgeLink.objects.get(item_id=item["item_id"])
    attachment = KnowledgeAttachment.objects.get(entry=entry)
    for statement in (
        lambda: KnowledgeEntry.objects.filter(id=entry.id).update(body="rewritten"),
        lambda: KnowledgeAttachment.objects.filter(id=attachment.id).delete(),
        lambda: KnowledgeLink.objects.filter(id=link.id).delete(),
        lambda: KnowledgeLink.objects.filter(id=link.id).update(fingerprint="0" * 64),
        lambda: KnowledgeItem.objects.filter(id=item["item_id"]).update(kind="note"),
        lambda: KnowledgeItem.objects.filter(id=item["item_id"]).update(version=2),
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            statement()
    op(users["editor"], "knowledge.unlink", {"link_id": str(link.id)})
    with pytest.raises(DatabaseError), transaction.atomic():
        KnowledgeLink.objects.filter(id=link.id).update(removal_reason="rewritten")
    other = op(users["outsider"], "project.create", {"name": "Other synthetic"})["project_id"]
    foreign = preserve(
        users["outsider"], other, "Foreign", b"foreign synthetic", "f.png", "image/png"
    )
    foreign_file = SourceBundleFile.objects.get(revision_id=foreign["revision_id"])
    with pytest.raises(DatabaseError), transaction.atomic():
        KnowledgeAttachment.objects.create(entry=entry, source_file=foreign_file)


def test_idempotent_create_replays_and_http_reads_share_authority(users, project, world, workspace):
    t = world["targets"]
    first = create(
        users["editor"], project, kind="note", body="Synthetic.", links=[t["r1"]], key="k1"
    )
    replay = create(
        users["editor"], project, kind="note", body="Synthetic.", links=[t["r1"]], key="k1"
    )
    assert replay["item_id"] == first["item_id"]
    assert KnowledgeItem.objects.count() == 1
    with pytest.raises(IdempotencyMismatch):
        create(users["editor"], project, kind="note", body="Different.", key="k1")

    response = api(users["viewer"]).get(f"/api/v0/knowledge/items/{first['item_id']}")
    assert response.status_code == 200 and response.json()["links"][0]["label"].endswith("1")
    assert (
        api(users["outsider"]).get(f"/api/v0/knowledge/items/{first['item_id']}").status_code == 404
    )
    base = f"/api/v0/knowledge/workspaces/{workspace}/items"
    listed = api(users["viewer"]).get(base).json()
    assert [row["item_id"] for row in listed["items"]] == [first["item_id"]]
    held = api(users["viewer"]).get(f"{base}?project_id={project}").json()
    assert [row["item_id"] for row in held["items"]] == [first["item_id"]]
    assert api(users["outsider"]).get(base).status_code == 404
    response = post_op(
        api(users["viewer"]),
        "knowledge.link",
        {"item_id": first["item_id"], "target": t["left"]},
    )
    assert response.status_code == 403
    response = post_op(
        api(users["editor"]),
        "knowledge.link",
        {"item_id": first["item_id"], "target": t["left"]},
    )
    assert response.status_code == 200
    assert response.json()["result"]["label"] == "Synthetic frame / left"


def test_replay_rechecks_current_authority(users, project, world):
    t = world["targets"]
    first = create(
        users["editor"], project, kind="note", body="Synthetic.", links=[t["r1"]], key="k2"
    )
    set_role(users["editor"], "viewer")
    with pytest.raises(PermissionDenied):
        create(users["editor"], project, kind="note", body="Synthetic.", links=[t["r1"]], key="k2")
    assert KnowledgeItem.objects.filter(id=first["item_id"]).exists()
