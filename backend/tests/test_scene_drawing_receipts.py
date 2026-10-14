"""Independent durable drawing history, source authority and competing retry checks."""

import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import close_old_connections, connection
from django.test import Client

from specmate.operations import Conflict, IdempotencyMismatch, NotFound
from specmate.operations.models import IdempotencyRecord
from specmate.shared_scene import drawing_operations, drawing_render
from specmate.shared_scene.models import SceneDrawing

from .conftest import member, op, remove_member
from .test_assemblies import create, freeze, occ
from .test_preparation import cable, profile
from .test_preparation import create as create_cuts
from .test_preparation import freeze as freeze_cuts
from .test_scene_drawings import drawing, read
from .test_shared_read_authority import adopt_with_remote_origin
from .test_sources import files, register, sha


def test_historic_receipt_limits_follow_retained_manifest_after_renderer_changes(users, project):
    user = users["owner"]
    root = freeze(user, create(user, project))
    created = copy.deepcopy(drawing(user, project, root))
    before = copy.deepcopy(read(user, created))
    original_limits = drawing_render.LIMITATIONS[:]
    try:
        # Simulate newer renderer guidance while preserving the original stored output.
        drawing_render.LIMITATIONS[:] = ["Updated limits for newly generated illustrations."]
        retained = read(user, created)
        assert retained["limitations"] == retained["manifest"]["limitations"]
        assert retained == before
        assert drawing(user, project, root) == created
    finally:
        drawing_render.LIMITATIONS[:] = original_limits


@pytest.mark.parametrize("protected", ["registered_source", "adopted_origin"])
def test_changed_key_retains_old_scene_authority_when_proposed_scene_drops_it(
    users, project, protected
):
    user = users["owner"]
    clean = freeze(user, create(user, project))
    if protected == "adopted_origin":
        remote, _, root = adopt_with_remote_origin(users, project, clean)
    else:
        remote = op(user, "project.create", {"name": "Original drawing evidence"})["project_id"]
        data = b"Original synthetic stock preparation evidence.\n"
        register(user, remote, data)
        source = op(
            user,
            "source.create_original_bundle",
            {"project_id": remote, "name": "Source instruction", "files": files(data)},
        )
        value, _ = cable(user, project)
        rules = profile(value["stock_revision_id"])
        rules["formulas"][0]["allowances"][0]["source"] = {
            "kind": "source_file",
            "bundle_revision_id": source["revision_id"],
            "path": "src/source.txt",
            "sha256": sha(data),
            "rights": "synthetic-original",
        }
        recipe = freeze_cuts(user, create_cuts(user, project, rules))
        root = freeze(user, create(user, project, [occ("preparation", recipe)]))
    # The viewer generates and reads; membership loss is the remaining revocation.
    user = users["viewer"]
    saved = drawing(user, project, root)
    before = read(user, saved)
    client = Client()
    client.force_login(user)
    url = f"/api/v0/shared-scenes/drawings/{saved['drawing_id']}"
    retained = {
        part: client.get(url + "/" + part).content for part in ("svg", "manifest", "package")
    }
    remove_member(user)
    assert op(
        users["owner"], "shared_scene.read_drawing_scene", {"snapshot_id": clean["snapshot_id"]}
    )
    # Proposed clean root has no protected inputs; the old receipt still does.
    with pytest.raises(NotFound):
        drawing(user, project, clean)
    with pytest.raises(NotFound):
        drawing(user, project, root)
    with pytest.raises(NotFound):
        read(user, saved)
    for part in ("svg", "manifest", "package", "invalid-part"):
        response = client.get(url + "/" + part)
        assert response.status_code == 404
        assert response.json()["error"]["message"] == "Not found."
    member(user, "viewer")
    assert drawing(user, project, root) == saved
    assert read(user, saved) == before
    assert {part: client.get(url + "/" + part).content for part in retained} == retained
    with pytest.raises(IdempotencyMismatch):
        drawing(user, project, clean)
    assert SceneDrawing.objects.count() == 1


@pytest.mark.django_db(transaction=True)
def test_competing_same_key_drawing_rolls_back_loser_and_replays_winning_bytes(
    users, project, monkeypatch
):
    user = users["owner"]
    root = freeze(user, create(user, project))
    barrier = Barrier(2)
    original_render = drawing_operations.render_drawing

    def rendezvous(*args):
        rendered = original_render(*args)
        barrier.wait(timeout=10)
        return rendered

    monkeypatch.setattr(drawing_operations, "render_drawing", rendezvous)

    def generate():
        close_old_connections()
        try:
            try:
                return drawing(user, project, root)
            except Conflict:
                return None
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: generate(), range(2)))
    saved = [result for result in results if result is not None]
    assert len(saved) == 1
    assert SceneDrawing.objects.count() == 1
    assert IdempotencyRecord.objects.filter(operation="shared_scene.create_drawing").count() == 1
    before = read(user, saved[0])
    record = SceneDrawing.objects.get()
    raw = bytes(record.svg), bytes(record.manifest)
    # Exact replay must not re-render (the rendezvous would otherwise time out).
    assert drawing(user, project, root) == saved[0]
    assert read(user, saved[0]) == before
    record.refresh_from_db()
    assert (bytes(record.svg), bytes(record.manifest)) == raw
