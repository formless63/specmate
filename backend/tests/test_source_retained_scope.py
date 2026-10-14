"""Retained outcome authority is independent of a changed incoming source pin."""

import pytest

from specmate.access.models import WorkspaceMember
from specmate.operations import Conflict, Context, IdempotencyMismatch, NotFound
from specmate.operations.models import IdempotencyRecord
from specmate.sources.models import SourceBundle, SourceBundleRevision
from specmate.sources.operations import FileRef, _write_revision, revision_result

from .conftest import op
from .test_catalog_matching import source_evidence
from .test_source_concurrency import files_with
from .test_source_editing import ORIGINAL, original


def cross_project_derivative(users, project):
    owner = users["owner"]
    parent_project = op(owner, "project.create", {"name": "Synthetic source origin"})["project_id"]
    parent = source_evidence(users, parent_project)
    local = original(users, project)
    local_revision = SourceBundleRevision.objects.get(id=local["revision_id"])
    bundle = SourceBundle.objects.create(
        project_id=project,
        name="Synthetic cross-project derivative",
        role="derivative",
        derived_from_id=parent["source_bundle_revision_id"],
        created_by=owner,
    )
    files = [
        FileRef(path=f.path, sha256=f.blob.sha256, media_type=f.media_type, rights=f.rights)
        for f in local_revision.files.select_related("blob")
    ]
    revision = _write_revision(
        Context(user=owner, via="job", request_id="source-scope-fixture"),
        bundle,
        files,
        ancestry=[parent["source_bundle_revision_id"]],
    )
    return revision_result(revision), parent_project


@pytest.mark.parametrize("operation", ["source.revise_bundle", "source.derive_bundle"])
@pytest.mark.parametrize("legacy", [False, True])
def test_changed_source_pin_authorizes_retained_outcome_before_mismatch(
    users, project, operation, legacy
):
    actor = users["owner"]
    source, parent_project = cross_project_derivative(users, project)
    other = original(users, project)
    if operation == "source.revise_bundle":
        payload = {
            "bundle_id": source["bundle_id"],
            "files": files_with(ORIGINAL["board/main.native"]),
        }
        changed = {**payload, "bundle_id": other["bundle_id"]}
        context = {"expected_state": source["state"]}
    else:
        payload = {"source_revision_id": source["revision_id"], "name": "Retained derivative"}
        changed = {**payload, "source_revision_id": other["revision_id"]}
        context = {}
    result = op(actor, operation, payload, idempotency_key="source-pin", **context)
    assert op(actor, operation, payload, idempotency_key="source-pin", **context) == result
    if legacy:
        IdempotencyRecord.objects.filter(actor=actor, operation=operation, key="source-pin").update(
            scope="legacy"
        )
    with pytest.raises(Conflict if legacy else IdempotencyMismatch):
        op(actor, operation, changed, idempotency_key="source-pin", **context)

    retained = SourceBundleRevision.objects.get(id=result["revision_id"])
    manifest = bytes(retained.manifest)
    # Only membership changes: the valid retained manifest and its ancestry remain intact.
    WorkspaceMember.objects.filter(workspace__projects=parent_project, user=actor).delete()
    for supplied in (changed, payload):
        with pytest.raises(NotFound, match="Project"):
            op(actor, operation, supplied, idempotency_key="source-pin", **context)
    retained.refresh_from_db()
    assert bytes(retained.manifest) == manifest
