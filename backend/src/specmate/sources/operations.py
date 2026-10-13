from __future__ import annotations

import hashlib
from uuid import UUID

from django.conf import settings
from django.db.models import Max
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic import ValidationError as PydanticValidationError

from specmate.access.permissions import Perm, authorize
from specmate.contracts import SHA256, SourceBundleManifest, check_package_path
from specmate.design.operations import canonical_bytes
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.sources import blobstore
from specmate.sources.authority import authorize_revision
from specmate.sources.models import (
    SourceBlob,
    SourceBundle,
    SourceBundleFile,
    SourceBundleRevision,
)


class RegisterBlob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: UUID
    sha256: str = Field(pattern=SHA256)
    size: int = Field(ge=0)
    media_type: str = Field(min_length=1, max_length=200)


@operation(
    "source.register_blob",
    RegisterBlob,
    summary="Register exact source bytes in a project after verifying declared hash and size.",
    attachments=("content",),
)
def register_blob(ctx: Context, p: RegisterBlob) -> dict:
    project = authorize(ctx.user, p.project_id, Perm.SOURCE_REGISTER)
    if p.size > settings.SPECMATE_MAX_SOURCE_BYTES:
        raise ValidationFailed("Declared size exceeds the configured limit.")
    try:
        staged = blobstore.stage(ctx.attachments["content"], settings.SPECMATE_MAX_SOURCE_BYTES)
    except blobstore.TooLarge:
        raise ValidationFailed("Content exceeds the configured limit.") from None
    if staged.sha256 != p.sha256 or staged.size != p.size:
        blobstore.discard(staged)
        raise ValidationFailed(
            "Content does not match the declared hash and size.",
            details={"received_sha256": staged.sha256, "received_size": staged.size},
        )
    blobstore.promote(staged)
    blob, created = SourceBlob.objects.get_or_create(
        project=project,
        sha256=p.sha256,
        defaults={"size": p.size, "media_type": p.media_type, "registered_by": ctx.user},
    )
    return {"blob_id": str(blob.id), "sha256": blob.sha256, "size": blob.size, "created": created}


class FileRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    sha256: str = Field(pattern=SHA256)
    media_type: str = Field(min_length=1, max_length=200)
    rights: str = Field(min_length=1, max_length=200)

    @field_validator("path")
    @classmethod
    def portable_path(cls, value: str) -> str:
        return check_package_path(value)


def bundle_state(bundle: SourceBundle, number: int) -> str:
    return f"bundle-r{number}"


def _write_revision(
    ctx: Context, bundle: SourceBundle, files: list[FileRef], ancestry: list[str]
) -> SourceBundleRevision:
    blobs = {
        b.sha256: b
        for b in SourceBlob.objects.filter(
            project=bundle.project, sha256__in={file.sha256 for file in files}
        )
    }
    entries = []
    for f in files:
        blob = blobs.get(f.sha256)
        if blob is None:
            raise ValidationFailed("File references bytes not registered in this project.")
        entries.append((f, blob))
    latest = bundle.revisions.aggregate(n=Max("number"))["n"] or 0
    revision = SourceBundleRevision(bundle=bundle, number=latest + 1, created_by=ctx.user)
    try:
        manifest = SourceBundleManifest(
            bundle_id=str(bundle.id),
            source_revision=str(revision.id),
            ancestry=ancestry,
            files=[
                {
                    "path": f.path,
                    "sha256": blob.sha256,
                    "bytes": blob.size,
                    "media_type": f.media_type,
                    "rights": f.rights,
                }
                for f, blob in sorted(entries, key=lambda e: e[0].path)
            ],
        )
    except PydanticValidationError as exc:
        reasons = [e["msg"] for e in exc.errors()]
        raise ValidationFailed("Invalid bundle manifest.", details={"reasons": reasons}) from None
    revision.manifest = canonical_bytes(manifest.model_dump(mode="json"))
    revision.manifest_sha256 = hashlib.sha256(revision.manifest).hexdigest()
    revision.save()
    SourceBundleFile.objects.bulk_create(
        SourceBundleFile(
            revision=revision, path=f.path, blob=blob, media_type=f.media_type, rights=f.rights
        )
        for f, blob in entries
    )
    return revision


def revision_result(revision: SourceBundleRevision) -> dict:
    return {
        "bundle_id": str(revision.bundle_id),
        "revision_id": str(revision.id),
        "number": revision.number,
        "manifest_sha256": revision.manifest_sha256,
        "state": bundle_state(revision.bundle, revision.number),
    }


class CreateBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: UUID
    name: str = Field(min_length=1, max_length=200)
    files: list[FileRef] = Field(min_length=1, max_length=10000)


@operation(
    "source.create_original_bundle",
    CreateBundle,
    summary="Preserve an imported original bundle as revision 1 of a new bundle.",
)
def create_original_bundle(ctx: Context, p: CreateBundle) -> dict:
    project = authorize(ctx.user, p.project_id, Perm.SOURCE_REGISTER)
    bundle = SourceBundle.objects.create(
        project=project, name=p.name, role=SourceBundle.Role.ORIGINAL, created_by=ctx.user
    )
    return revision_result(_write_revision(ctx, bundle, p.files, ancestry=[]))


class ReviseBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bundle_id: UUID
    files: list[FileRef] = Field(min_length=1, max_length=10000)


def authorized_head(ctx: Context, bundle_id) -> SourceBundleRevision:
    """Current head after full closure authorization; never reveals state before it."""
    bundle = SourceBundle.objects.filter(id=bundle_id).first()
    if bundle is None:
        raise NotFound("Bundle not found.")
    authorize(ctx.user, bundle.project_id, Perm.SOURCE_REGISTER)
    head = bundle.revisions.select_related("bundle").order_by("-number").first()
    authorize_revision(ctx.user, head, Perm.SOURCE_REGISTER)
    return head


def head_details(head: SourceBundleRevision) -> dict:
    return {
        "current": bundle_state(head.bundle, head.number),
        "head_revision_id": str(head.id),
        "head_number": head.number,
        "head_manifest_sha256": head.manifest_sha256,
    }


def _revise_replay(ctx: Context, p: ReviseBundle, result) -> None:
    authorized_head(ctx, p.bundle_id)
    produced = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=result["revision_id"], bundle_id=p.bundle_id)
        .first()
    )
    if produced is None:
        raise NotFound("Bundle revision not found.")
    authorize_revision(ctx.user, produced)


def _revise_scope(ctx: Context, p: ReviseBundle) -> str:
    from specmate.operations.models import IdempotencyRecord
    from specmate.operations.scope import LEGACY_SCOPE

    head = authorized_head(ctx, p.bundle_id)
    scope = f"project:{head.bundle.project_id}"
    # Current authority over a retained outcome precedes even a keyed mismatch.
    prior = IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user, operation="source.revise_bundle", key=ctx.idempotency_key
    )
    retained = prior.filter(scope=scope).first() or prior.filter(scope=LEGACY_SCOPE).first()
    if retained is not None:
        _revise_replay(ctx, p, retained.result)
    return scope


@operation(
    "source.revise_bundle",
    ReviseBundle,
    summary="Add a revision (re-import of an original, or an edit of a derivative).",
    requires_expected_state=True,
    idempotency_scope=_revise_scope,
    authorize_replay=_revise_replay,
)
def revise_bundle(ctx: Context, p: ReviseBundle) -> dict:
    authorized_head(ctx, p.bundle_id)
    # Serialize writers on the bundle row; the head is reread under the lock.
    bundle = SourceBundle.objects.select_for_update().get(id=p.bundle_id)
    previous = bundle.revisions.select_related("bundle").order_by("-number").first()
    if ctx.expected_state != bundle_state(bundle, previous.number):
        authorize_revision(ctx.user, previous, Perm.SOURCE_REGISTER)
        raise Conflict(
            "Bundle changed since expected state. Nothing was overwritten; review the "
            "current head and submit again.",
            details=head_details(previous),
        )
    ancestry = [str(previous.id)]
    return revision_result(_write_revision(ctx, bundle, p.files, ancestry=ancestry))


class DeriveBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_revision_id: UUID
    name: str = Field(min_length=1, max_length=200)


def _derive_source(ctx: Context, p: DeriveBundle) -> SourceBundleRevision:
    source = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=p.source_revision_id)
        .first()
    )
    if source is None:
        raise NotFound("Bundle revision not found.")
    authorize_revision(ctx.user, source, Perm.SOURCE_REGISTER)
    return source


def _derive_replay(ctx: Context, p: DeriveBundle, result) -> None:
    source = _derive_source(ctx, p)
    produced = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=result["revision_id"], bundle__derived_from=source)
        .first()
    )
    if produced is None:
        raise NotFound("Bundle revision not found.")
    authorize_revision(ctx.user, produced)


def _derive_scope(ctx: Context, p: DeriveBundle) -> str:
    from specmate.operations.models import IdempotencyRecord
    from specmate.operations.scope import LEGACY_SCOPE

    source = _derive_source(ctx, p)
    scope = f"project:{source.bundle.project_id}"
    prior = IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user, operation="source.derive_bundle", key=ctx.idempotency_key
    )
    retained = prior.filter(scope=scope).first() or prior.filter(scope=LEGACY_SCOPE).first()
    if retained is not None:
        _derive_replay(ctx, p, retained.result)
    return scope


@operation(
    "source.derive_bundle",
    DeriveBundle,
    summary="Start an editable derivative bundle with its own identity from a revision.",
    idempotency_scope=_derive_scope,
    authorize_replay=_derive_replay,
)
def derive_bundle(ctx: Context, p: DeriveBundle) -> dict:
    source = _derive_source(ctx, p)
    bundle = SourceBundle.objects.create(
        project_id=source.bundle.project_id,
        name=p.name,
        role=SourceBundle.Role.DERIVATIVE,
        derived_from=source,
        created_by=ctx.user,
    )
    files = [
        FileRef(path=f.path, sha256=f.blob.sha256, media_type=f.media_type, rights=f.rights)
        for f in source.files.select_related("blob")
    ]
    return revision_result(_write_revision(ctx, bundle, files, ancestry=[str(source.id)]))
