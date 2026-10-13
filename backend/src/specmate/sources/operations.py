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
    blobs = {b.sha256: b for b in SourceBlob.objects.filter(project=bundle.project)}
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


@operation(
    "source.revise_bundle",
    ReviseBundle,
    summary="Add a revision (re-import of an original, or an edit of a derivative).",
    requires_expected_state=True,
)
def revise_bundle(ctx: Context, p: ReviseBundle) -> dict:
    bundle = SourceBundle.objects.select_for_update().filter(id=p.bundle_id).first()
    if bundle is None:
        raise NotFound("Bundle not found.")
    authorize(ctx.user, bundle.project_id, Perm.SOURCE_REGISTER)
    previous = bundle.revisions.order_by("-number").first()
    current = bundle_state(bundle, previous.number)
    if ctx.expected_state != current:
        raise Conflict("Bundle changed since expected state.", details={"current": current})
    ancestry = [str(previous.id)]
    return revision_result(_write_revision(ctx, bundle, p.files, ancestry=ancestry))


class DeriveBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_revision_id: UUID
    name: str = Field(min_length=1, max_length=200)


@operation(
    "source.derive_bundle",
    DeriveBundle,
    summary="Start an editable derivative bundle with its own identity from a revision.",
)
def derive_bundle(ctx: Context, p: DeriveBundle) -> dict:
    source = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=p.source_revision_id)
        .first()
    )
    if source is None:
        raise NotFound("Bundle revision not found.")
    project = authorize(ctx.user, source.bundle.project_id, Perm.SOURCE_REGISTER)
    bundle = SourceBundle.objects.create(
        project=project,
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
