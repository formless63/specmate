"""Independent retained-receipt authority regressions for document generation."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import pytest
from django.db import close_old_connections, connection

from specmate.access.models import Membership
from specmate.operations import Conflict, IdempotencyMismatch, NotFound, PermissionDenied
from specmate.operations.models import IdempotencyRecord
from specmate.preparation_documents import operations
from specmate.preparation_documents.api import records
from specmate.preparation_documents.models import DocumentOutput, DocumentSet

from .conftest import op
from .test_preparation import cable, profile
from .test_preparation import create as create_cuts
from .test_preparation import freeze as freeze_cuts
from .test_preparation_documents import configuration, files, retain
from .test_shared_read_authority import adopt_with_remote_origin, restore, revoke
from .test_sources import files as source_files
from .test_sources import register, sha
from .test_transports import api


def test_mounted_document_routes_preserve_viewer_bytes_and_hide_outside_receipts(users, project):
    _, root = cable(users["owner"], project)
    _, saved = retain(users["owner"], configuration(root))
    expected = files(users["viewer"], saved)
    viewer = api(users["viewer"])
    listing = viewer.get(f"/api/v0/preparation-documents/projects/{project}")
    assert listing.status_code == 200
    assert listing["Cache-Control"] == "private, no-store"
    assert listing.json()["document_sets"] == [saved]
    receipt_url = f"/api/v0/preparation-documents/sets/{saved['document_set_id']}"
    response = viewer.get(receipt_url)
    assert response.status_code == 200
    assert response.json() == saved
    assert response["Cache-Control"] == "private, no-store"
    for filename, content in expected.items():
        response = viewer.post(
            "/api/v0/preparation-documents/download",
            data=json.dumps({"document_set_id": saved["document_set_id"], "filename": filename}),
            content_type="application/json",
        )
        assert response.status_code == 200
        assert response.content == content
        assert response["Cache-Control"] == "private, no-store"
        assert response["X-Content-Type-Options"] == "nosniff"
    outsider = api(users["outsider"])
    assert outsider.get(receipt_url).status_code == 404
    assert outsider.get(f"/api/v0/preparation-documents/projects/{project}").status_code == 404
    response = outsider.post(
        "/api/v0/preparation-documents/download",
        data=json.dumps({"document_set_id": saved["document_set_id"], "filename": "schematic.svg"}),
        content_type="application/json",
    )
    assert response.status_code == 404
    assert response.json()["error"]["details"] == {}


@pytest.mark.django_db(transaction=True)
def test_source_revoked_during_promotion_rolls_back_receipt_and_key(users, project, monkeypatch):
    from specmate.sources import blobstore

    user = users["owner"]
    value, root = cable(user, project)
    foreign = op(user, "project.create", {"name": "Concurrent allowance evidence"})["project_id"]
    data = b"Original synthetic allowance evidence for concurrent access checks.\n"
    register(user, foreign, data)
    source = op(
        user,
        "source.create_original_bundle",
        {"project_id": foreign, "name": "Allowance", "files": source_files(data)},
    )
    rules = profile(value["stock_revision_id"])
    rules["formulas"][0]["allowances"][0]["source"] = {
        "kind": "source_file",
        "bundle_revision_id": source["revision_id"],
        "path": "src/source.txt",
        "sha256": sha(data),
        "rights": "synthetic-original",
    }
    recipe = freeze_cuts(user, create_cuts(user, project, rules))
    config = configuration(
        root, bindings=[{"cut_profiles": [{"profile_revision_id": recipe["revision_id"]}]}]
    )
    review = op(user, "preparation_documents.review", config)
    original = blobstore.promote
    revoked = False

    def revoke_in_competing_connection():
        close_old_connections()
        try:
            count, _ = Membership.objects.filter(user_id=user.pk, project_id=foreign).delete()
            assert count == 1
        finally:
            close_old_connections()

    def promote_then_revoke(staged):
        nonlocal revoked
        result = original(staged)
        if not revoked:
            revoked = True
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(revoke_in_competing_connection).result(timeout=10)
        return result

    monkeypatch.setattr(blobstore, "promote", promote_then_revoke)
    with pytest.raises(NotFound):
        op(
            user,
            "preparation_documents.generate",
            config,
            expected_state=review["state"],
            idempotency_key="promotion-recovery",
        )
    assert revoked
    assert not Membership.objects.filter(user=user, project_id=foreign).exists()
    assert DocumentSet.objects.count() == DocumentOutput.objects.count() == 0
    assert not IdempotencyRecord.objects.filter(operation="preparation_documents.generate").exists()
    Membership.objects.create(user=user, project_id=foreign, role="owner")
    recovered = op(
        user,
        "preparation_documents.generate",
        config,
        expected_state=review["state"],
        idempotency_key="promotion-recovery",
    )
    assert len(files(user, recovered)) == 6
    assert DocumentSet.objects.count() == 1
    assert DocumentOutput.objects.count() == 6


def test_changed_key_cannot_drop_revoked_receipt_source_before_diagnostics(users, project):
    user = users["owner"]
    value, root = cable(user, project)
    foreign = op(user, "project.create", {"name": "Original recipe evidence"})["project_id"]
    data = b"Original synthetic allowance basis, retained by its owning project.\n"
    register(user, foreign, data)
    source = op(
        user,
        "source.create_original_bundle",
        {"project_id": foreign, "name": "Allowance basis", "files": source_files(data)},
    )
    pin = {
        "kind": "source_file",
        "bundle_revision_id": source["revision_id"],
        "path": "src/source.txt",
        "sha256": sha(data),
        "rights": "synthetic-original",
    }
    rules = profile(value["stock_revision_id"])
    rules["formulas"][0]["allowances"][0]["source"] = pin
    recipe = freeze_cuts(user, create_cuts(user, project, rules))
    config = configuration(
        root, bindings=[{"cut_profiles": [{"profile_revision_id": recipe["revision_id"]}]}]
    )
    review, saved = retain(user, config)
    original = files(user, saved)
    changed = configuration(root)  # Same root, but no longer proposes protected recipe/source.
    Membership.objects.filter(user=user, project_id=foreign).delete()
    assert op(user, "preparation_documents.review", changed)
    with pytest.raises(NotFound):
        op(user, "preparation_documents.read", {"document_set_id": saved["document_set_id"]})
    with pytest.raises(NotFound):
        files(user, saved)
    with pytest.raises(NotFound):
        op(
            user,
            "preparation_documents.review",
            {**config, "bindings": [{**config["bindings"][0], "occurrence_path": ["missing"]}]},
        )
    with pytest.raises((NotFound, PermissionDenied)):
        op(
            user,
            "preparation_documents.generate",
            changed,
            expected_state=review["state"],
            idempotency_key="documents",
        )
    Membership.objects.create(user=user, project_id=foreign, role="owner")
    with pytest.raises(IdempotencyMismatch):
        op(
            user,
            "preparation_documents.generate",
            changed,
            expected_state=review["state"],
            idempotency_key="documents",
        )
    assert (
        op(
            user,
            "preparation_documents.generate",
            config,
            expected_state=review["state"],
            idempotency_key="documents",
        )
        == saved
    )
    assert files(user, saved) == original
    assert DocumentSet.objects.count() == 1
    assert DocumentOutput.objects.count() == 6


def test_valid_catalog_origin_denies_whole_set_before_bad_binding_and_restores(users, project):
    user, viewer = users["owner"], users["viewer"]
    _, original = cable(user, project)
    remote, _, root = adopt_with_remote_origin(users, project, original)
    config = configuration(root)
    _, saved = retain(user, config)
    before = files(viewer, saved)
    receipt = {"document_set_id": saved["document_set_id"]}
    request = SimpleNamespace(user=viewer)
    response = records(request, project)
    assert response["Cache-Control"] == "private, no-store"
    assert json.loads(response.content)["document_sets"] == [saved]
    revoke(users, remote)  # Unselected retained pack entry, not a wiring child.
    with pytest.raises(NotFound, match="Project not found"):
        op(
            viewer,
            "preparation_documents.review",
            {**config, "bindings": [{"occurrence_path": ["missing"]}]},
        )
    with pytest.raises(NotFound, match="Project not found"):
        op(viewer, "preparation_documents.read", receipt)
    with pytest.raises(NotFound, match="Project not found"):
        files(viewer, saved)
    response = records(request, project)
    assert response["Cache-Control"] == "private, no-store"
    assert json.loads(response.content)["document_sets"] == []
    restore(users, remote)
    assert op(viewer, "preparation_documents.read", receipt) == saved
    response = records(request, project)
    assert response["Cache-Control"] == "private, no-store"
    assert json.loads(response.content)["document_sets"] == [saved]
    assert files(viewer, saved) == before
    assert DocumentSet.objects.count() == 1
    assert DocumentOutput.objects.count() == 6


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_key_publishes_one_complete_set_and_replays_exact_bytes(
    users, project, monkeypatch, artifact_root
):
    user = users["owner"]
    _, root = cable(user, project)
    config = configuration(root)
    review = op(user, "preparation_documents.review", config)
    barrier = Barrier(2)
    original_render = operations.render

    def rendezvous(projection):
        rendered = original_render(projection)
        barrier.wait(timeout=10)
        return rendered

    monkeypatch.setattr(operations, "render", rendezvous)

    def generate():
        close_old_connections()
        try:
            try:
                return op(
                    user,
                    "preparation_documents.generate",
                    config,
                    expected_state=review["state"],
                    idempotency_key="concurrent-documents",
                )
            except Conflict:
                return None
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: generate(), range(2)))
    saved = [result for result in results if result is not None]
    assert len(saved) == 1
    assert DocumentSet.objects.count() == 1
    assert DocumentOutput.objects.count() == 6
    assert IdempotencyRecord.objects.filter(operation="preparation_documents.generate").count() == 1
    assert not list((artifact_root / "staging").iterdir())
    before = files(user, saved[0])
    # Replay must not render at all (the rendezvous would otherwise time out).
    assert (
        op(
            user,
            "preparation_documents.generate",
            config,
            expected_state=review["state"],
            idempotency_key="concurrent-documents",
        )
        == saved[0]
    )
    assert files(user, saved[0]) == before
