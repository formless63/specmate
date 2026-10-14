"""Independent valid source-origin, failure isolation and snapshot replay review."""

import copy
import json
from uuid import UUID

import pytest

from specmate.access.models import WorkspaceMember
from specmate.catalog_packs.models import AdoptionEntry
from specmate.design.models import Snapshot
from specmate.design.operations import authorize_snapshot
from specmate.operations import Conflict, NotFound
from specmate.queries import get_draft

from .conftest import ensure_member, op
from .test_bom import assembly, capture, create, part
from .test_catalog_packs import adopt, install, manifest, registered
from .test_sources import files, register, sha
from .test_transports import api, post_op


@pytest.fixture
def source_origin(users, project):
    remote = op(users["owner"], "project.create", {"name": "Independent inert source origin"})[
        "project_id"
    ]
    for name in ("editor", "viewer"):
        ensure_member(users[name], "viewer", project=remote)
    data = b"Synthetic inert declaration; no geometry, solver or device evidence.\n"
    register(users["owner"], remote, data)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {"project_id": remote, "name": "Independent original source", "files": files(data)},
    )
    original = part(users["owner"], project, "Independent reusable part")
    entries = manifest(original)["entries"] + [
        {
            "key": "source",
            "label": "Inert model source; correspondence unknown",
            "category": "model",
            "source": {
                "source_bundle_revision_id": source["revision_id"],
                "source_path": "src/source.txt",
                "sha256": sha(data),
                "rights": "synthetic-original",
            },
            "rights": "synthetic-original",
        }
    ]
    version = registered(users, project, original, entries=entries)
    install(users, version)
    adopt(users, version)
    adopted = AdoptionEntry.objects.get()
    draft = get_draft(users["owner"], adopted.draft_id)
    frozen = capture(users["owner"], draft)
    return remote, original, frozen


def test_failed_batch_preserves_prior_success_without_publishing_failed_origin(
    users, project, source_origin
):
    remote, _, adopted = source_origin
    safe = part(users["owner"], project, "Independent readable completed input")
    root = assembly(users["owner"], project, [("left", adopted), ("right", adopted)])
    completed = set()
    authorize_snapshot(
        users["viewer"], Snapshot.objects.get(pk=safe["snapshot_id"]), _authorized=completed
    )
    prior = completed.copy()
    assert prior == {UUID(safe["snapshot_id"])}
    WorkspaceMember.objects.filter(workspace__projects=remote, user=users["viewer"]).delete()
    with pytest.raises(NotFound, match=r"^Project not found\.$"):
        authorize_snapshot(
            users["viewer"], Snapshot.objects.get(pk=root["snapshot_id"]), _authorized=completed
        )
    assert completed == prior
    ensure_member(users["viewer"], "viewer", project=remote)
    authorize_snapshot(
        users["viewer"], Snapshot.objects.get(pk=root["snapshot_id"]), _authorized=completed
    )
    assert UUID(root["snapshot_id"]) in completed and UUID(adopted["snapshot_id"]) in completed
    assert prior <= completed


@pytest.mark.parametrize("operation", ["bom.snapshot", "draft.snapshot"])
def test_snapshot_replay_uses_fresh_source_origin_before_stale_cas_and_preserves_history(
    users, project, source_origin, operation
):
    remote, original, adopted = source_origin
    actor = users["editor"]
    root = assembly(users["owner"], project, [("left", adopted), ("right", adopted)])
    plan = {"assembly_revision_id": root["revision_id"]}
    draft = create(actor, project, plan)
    snap = capture(actor, draft, operation, idempotency_key="independent-snapshot")
    row = Snapshot.objects.get(pk=snap["snapshot_id"])
    raw = bytes(row.canonical)
    assert {UUID(pin["revision_id"]): pin["sha256"] for pin in json.loads(raw)["dependencies"]} == {
        UUID(item["revision_id"]): item["sha256"] for item in (root, original, adopted)
    }
    updated_plan = copy.deepcopy(plan)
    updated_plan["quantity"] = {"status": "known", "amount": 2}
    op(
        actor,
        "bom.update",
        {"draft_id": draft["draft_id"], "bom": updated_plan},
        expected_state=draft["state"],
    )
    WorkspaceMember.objects.filter(workspace__projects=remote, user=actor).delete()
    count = Snapshot.objects.count()
    for key in (None, "independent-snapshot"):
        with pytest.raises(NotFound, match=r"^Project not found\.$"):
            capture(actor, draft, operation, idempotency_key=key)
    denied = post_op(
        api(actor),
        operation,
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        idempotency_key="independent-snapshot",
    )
    assert denied.status_code == 404 and "snapshot_id" not in denied.json()
    assert Snapshot.objects.count() == count and bytes(row.canonical) == raw
    ensure_member(actor, "viewer", project=remote)
    assert capture(actor, draft, operation, idempotency_key="independent-snapshot") == snap
    with pytest.raises(Conflict):
        capture(actor, draft, operation)
    replay = post_op(
        api(actor),
        operation,
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        idempotency_key="independent-snapshot",
    )
    assert replay.status_code == 200 and replay.json()["result"] == snap
    assert bytes(Snapshot.objects.get(pk=snap["snapshot_id"]).canonical) == raw
