"""Checked-in packages exercise source intake, not native-tool qualification."""

import hashlib
import io
import json
from pathlib import Path

import pytest

from specmate.contracts import SourceBundleManifest
from specmate.operations import IdempotencyMismatch, ValidationFailed
from specmate.sources import blobstore
from specmate.sources.models import SourceBlob, SourceBundle, SourceBundleRevision

from .conftest import op
from .scope_helpers import workspace_of

FIXTURES = Path(__file__).resolve().parents[2] / "tests/fixtures"
PACKAGES = [
    pytest.param(
        "bundles/original-package/manifest.json",
        "bundles/original-package/files",
        id="original-package",
    ),
    pytest.param(
        "native/kicad/source-bundle.json",
        "native/kicad",
        id="native-kicad",
    ),
]


def package(manifest_path, files_path):
    manifest = SourceBundleManifest.model_validate_json((FIXTURES / manifest_path).read_text())
    assert manifest.synthetic and manifest.ancestry == []
    root = FIXTURES / files_path
    for entry in manifest.files:
        source = root / entry.path
        cursor = source
        while cursor != root:
            assert not cursor.is_symlink()
            cursor = cursor.parent
        assert source.resolve().is_relative_to(root.resolve())
        content = source.read_bytes()
        assert len(content) == entry.bytes, entry.path
        assert hashlib.sha256(content).hexdigest() == entry.sha256, entry.path
    return manifest, root


def file_refs(manifest):
    return [entry.model_dump(exclude={"bytes"}) for entry in manifest.files]


def register(user, project, entry, content, *, key=None):
    return op(
        user,
        "source.register_blob",
        {
            "workspace_id": workspace_of(project),
            "sha256": entry.sha256,
            "size": entry.bytes,
            "media_type": entry.media_type,
        },
        attachments={"content": io.BytesIO(content)},
        idempotency_key=key,
    )


@pytest.mark.parametrize(("manifest_path", "files_path"), PACKAGES)
def test_checked_in_package_matches_declared_contract(manifest_path, files_path):
    manifest, root = package(manifest_path, files_path)
    if root.name == "files":
        assert {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()} == {
            entry.path for entry in manifest.files
        }


@pytest.mark.parametrize(("manifest_path", "files_path"), PACKAGES)
def test_package_registers_replays_and_reconstructs_with_ancestry(
    users, project, tmp_path, manifest_path, files_path
):
    manifest, root = package(manifest_path, files_path)
    user = users["editor"]
    for entry in manifest.files:
        register(user, project, entry, (root / entry.path).read_bytes())
    payload = {
        "workspace_id": workspace_of(project),
        "name": manifest.bundle_id,
        "files": file_refs(manifest),
    }
    original = op(user, "source.create_original_bundle", payload, idempotency_key="import-package")
    # Retrying after a lost response returns the same immutable source revision.
    replay = op(user, "source.create_original_bundle", payload, idempotency_key="import-package")
    assert replay == original
    assert SourceBundle.objects.count() == SourceBundleRevision.objects.count() == 1
    with pytest.raises(IdempotencyMismatch):
        op(
            user,
            "source.create_original_bundle",
            {**payload, "name": "Different import"},
            idempotency_key="import-package",
        )

    revision = SourceBundleRevision.objects.get(id=original["revision_id"])
    stored = SourceBundleManifest.model_validate_json(bytes(revision.manifest))
    assert stored.bundle_id == original["bundle_id"]
    assert stored.source_revision == original["revision_id"]
    assert stored.bundle_id != manifest.bundle_id
    assert stored.ancestry == []
    assert stored.files == sorted(manifest.files, key=lambda entry: entry.path)
    assert hashlib.sha256(bytes(revision.manifest)).hexdigest() == original["manifest_sha256"]
    original_manifest_bytes = bytes(revision.manifest)

    # Reconstruct only from the saved manifest and registered blob bytes.
    reconstructed = tmp_path / "reconstructed"
    for entry in stored.files:
        target = reconstructed / entry.path
        target.parent.mkdir(parents=True, exist_ok=True)
        with blobstore.open_blob(entry.sha256) as source:
            target.write_bytes(source.read())
        assert target.read_bytes() == (root / entry.path).read_bytes()
    assert revision.files.count() == len(manifest.files)

    derivative = op(
        user,
        "source.derive_bundle",
        {"source_revision_id": original["revision_id"], "name": "Editable package"},
    )
    assert derivative["bundle_id"] != original["bundle_id"]
    derived = SourceBundleRevision.objects.get(id=derivative["revision_id"])
    assert str(derived.bundle.derived_from_id) == original["revision_id"]
    derived_manifest = SourceBundleManifest.model_validate_json(bytes(derived.manifest))
    assert derived_manifest.ancestry == [original["revision_id"]]
    assert derived_manifest.files == stored.files
    revision.refresh_from_db()
    assert bytes(revision.manifest) == original_manifest_bytes


@pytest.mark.parametrize("corruption", ["truncated", "same-size-changed"])
def test_partial_package_intake_can_retry_without_replacing_original_bytes(
    users, project, artifact_root, corruption
):
    manifest, root = package(
        "bundles/original-package/manifest.json", "bundles/original-package/files"
    )
    user = users["editor"]
    first, retry, *remaining = manifest.files
    register(user, project, first, (root / first.path).read_bytes())
    original_bytes = (root / retry.path).read_bytes()
    damaged = original_bytes[:-1] if corruption == "truncated" else b"!" + original_bytes[1:]
    with pytest.raises(ValidationFailed, match="does not match"):
        register(user, project, retry, damaged, key="retry-upload")
    assert list(SourceBlob.objects.values_list("sha256", flat=True)) == [first.sha256]
    assert not blobstore.blob_path(retry.sha256).exists()
    assert list((artifact_root / "staging").iterdir()) == []

    payload = {
        "workspace_id": workspace_of(project),
        "name": "Recovered package",
        "files": file_refs(manifest),
    }
    with pytest.raises(ValidationFailed, match="not registered"):
        op(user, "source.create_original_bundle", payload, idempotency_key="retry-package")
    assert not SourceBundle.objects.exists()
    assert not SourceBundleRevision.objects.exists()

    # Failed requests must not consume either retry key or leave a partial bundle.
    register(user, project, retry, original_bytes, key="retry-upload")
    for entry in remaining:
        register(user, project, entry, (root / entry.path).read_bytes())
    result = op(user, "source.create_original_bundle", payload, idempotency_key="retry-package")
    assert (
        op(user, "source.create_original_bundle", payload, idempotency_key="retry-package")
        == result
    )
    assert SourceBundle.objects.count() == SourceBundleRevision.objects.count() == 1
    assert SourceBlob.objects.count() == len(manifest.files)
    with blobstore.open_blob(retry.sha256) as stored:
        assert stored.read() == original_bytes


UNSAFE_PATHS = json.loads((FIXTURES / "unsafe-imports.json").read_text())["reject_paths"]


@pytest.mark.parametrize("bad_path", [*UNSAFE_PATHS, "duplicate", "case-collision"])
def test_package_path_rejection_rolls_back_and_allows_corrected_retry(users, project, bad_path):
    manifest, root = package(
        "bundles/original-package/manifest.json", "bundles/original-package/files"
    )
    user = users["editor"]
    for entry in manifest.files:
        register(user, project, entry, (root / entry.path).read_bytes())
    refs = file_refs(manifest)
    if bad_path == "duplicate":
        invalid = [*refs, refs[0]]
    elif bad_path == "case-collision":
        invalid = [*refs, {**refs[0], "path": refs[0]["path"].upper()}]
    else:
        invalid = [{**refs[0], "path": bad_path}, *refs[1:]]
    payload = {"workspace_id": workspace_of(project), "name": "Validated package", "files": invalid}
    with pytest.raises(ValidationFailed):
        op(user, "source.create_original_bundle", payload, idempotency_key="validated-package")
    assert not SourceBundle.objects.exists()
    assert not SourceBundleRevision.objects.exists()
    result = op(
        user,
        "source.create_original_bundle",
        {**payload, "files": refs},
        idempotency_key="validated-package",
    )
    assert result["number"] == 1
    assert SourceBundle.objects.count() == SourceBundleRevision.objects.count() == 1
