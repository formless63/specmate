"""Exact conversion provenance follows existing authority, revision and export rules."""

import hashlib
import json

import pytest

from specmate.catalog.queries import get_revision_catalog
from specmate.design.models import Definition, Snapshot
from specmate.operations import Conflict, NotFound, ValidationFailed
from specmate.queries import get_revision

from .conftest import member, op, remove_member
from .test_sources import ORIGINAL, files, register
from .test_transports import api, post_op


def source_origin(user, workspace, **changes):
    register(user, workspace, ORIGINAL)
    source = op(
        user,
        "source.create_original_bundle",
        {
            "workspace_id": workspace,
            "name": "Synthetic predecessor source",
            "files": files(ORIGINAL),
        },
    )
    return {
        "namespace": "synthetic.catalog",
        "record_key": "probe-part",
        "converter": "fixture/1",
        "source_bundle_revision_id": source["revision_id"],
        "source_path": "src/source.txt",
        "sha256": hashlib.sha256(ORIGINAL).hexdigest(),
        "rights": "synthetic-original",
        **changes,
    }


def create(user, workspace, origin, **ctx):
    return op(
        user,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "part",
            "name": "Synthetic converted part",
            "content": {"source_origins": [origin]},
        },
        **ctx,
    )


def freeze(user, draft):
    return op(user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"])


def test_source_origin_freeze_read_catalog_and_exact_selected_source_export(users, workspace):
    origin = source_origin(users["owner"], workspace, upstream_revision="0", source_status="legacy")
    draft = create(users["owner"], workspace, origin, idempotency_key="origin-create")
    assert create(users["owner"], workspace, origin, idempotency_key="origin-create") == draft
    frozen = freeze(users["owner"], draft)
    revision = get_revision(users["viewer"], frozen["revision_id"])
    canonical = bytes(revision.snapshot.canonical)
    captured = json.loads(canonical)["content"]["source_origins"][0]
    assert captured["upstream_revision"] == "0"  # Never equated with Specmate's r1.
    assert captured["sha256"] == hashlib.sha256(ORIGINAL).hexdigest()
    assert get_revision_catalog(users["viewer"], revision.id)["source_origins"] == [captured]
    payload = {
        "root_revision_id": str(revision.id),
        "rights_reviews": [
            {
                "subject": f"source:{origin['source_bundle_revision_id']}:src/source.txt",
                "decision": "permitted",
                "basis": "Original synthetic input",
            }
        ],
    }
    review = op(users["viewer"], "selected_package.review", payload)
    sources = review["manifest"]["source_files"]
    assert len(sources) == 1 and sources[0]["status"] == "included_inert"
    assert sources[0]["sha256"] == origin["sha256"]
    assert sources[0]["declared_rights"] == "synthetic-original"
    export = op(users["viewer"], "export_package.review", {"root_revision_id": str(revision.id)})
    rights = export["manifest"]["rights"]["items"]
    assert any(r["record"] == "source_origin" and r["sha256"] == origin["sha256"] for r in rights)
    assert bytes(Snapshot.objects.get(id=revision.snapshot_id).canonical) == canonical


@pytest.mark.parametrize(
    "change",
    [
        {"sha256": "0" * 64},
        {"rights": "different"},
        {"source_path": "missing"},
        {"sha256": "bad"},
        {"namespace": ""},
        {"source_status": "approved"},
    ],
)
def test_origin_invalid_metadata_rolls_back(users, workspace, change):
    origin = source_origin(users["owner"], workspace)
    before = Definition.objects.count()
    with pytest.raises((ValidationFailed, NotFound)):
        create(users["owner"], workspace, {**origin, **change})
    assert Definition.objects.count() == before


def test_origin_cross_workspace_and_current_authority_hide_replay_and_reads(
    users, workspace, other_workspace
):
    origin = source_origin(users["outsider"], other_workspace)
    member(users["owner"], "editor", workspace=other_workspace)
    with pytest.raises(NotFound):
        create(users["owner"], workspace, origin)
    origin = source_origin(users["owner"], workspace)
    draft = create(users["owner"], workspace, origin, idempotency_key="retained-origin")
    frozen = freeze(users["owner"], draft)
    remove_member(users["owner"], workspace=workspace)
    with pytest.raises(NotFound):
        create(users["owner"], workspace, origin, idempotency_key="retained-origin")
    with pytest.raises(NotFound):
        get_revision(users["owner"], frozen["revision_id"])
    response = post_op(
        api(users["outsider"]),
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "part",
            "name": "Unreachable",
            "content": {"source_origins": [origin]},
        },
    )
    assert response.status_code == 404


def test_origin_update_cas_and_previous_frozen_bytes_unchanged(users, workspace):
    origin = source_origin(users["owner"], workspace)
    draft = create(users["owner"], workspace, origin)
    frozen = freeze(users["owner"], draft)
    old = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    changed = op(
        users["owner"],
        "draft.update",
        {
            "draft_id": draft["draft_id"],
            "changes": {"source_origins": [{**origin, "converter": "fixture/2"}]},
        },
        expected_state=frozen["draft"]["state"],
    )
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "draft.update",
            {"draft_id": draft["draft_id"], "changes": {}},
            expected_state=frozen["draft"]["state"],
        )
    assert changed["content"]["source_origins"][0]["converter"] == "fixture/2"
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == old
