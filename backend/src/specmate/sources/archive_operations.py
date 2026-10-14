"""Explicit inert ZIP derivation from a preserved, currently authorized source."""

import hashlib
from typing import Literal
from uuid import UUID

from django.conf import settings
from pydantic import BaseModel, ConfigDict, Field, field_validator

from specmate.access.permissions import Perm
from specmate.contracts import check_package_path
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.sources import blobstore, zip_intake
from specmate.sources.authority import authorize_revision
from specmate.sources.models import (
    SourceArchiveExpansion,
    SourceBlob,
    SourceBundle,
    SourceBundleRevision,
)
from specmate.sources.operations import FileRef, _write_revision, revision_result


class ExpandZip(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_revision_id: UUID
    path: str
    name: str = Field(min_length=1, max_length=200)
    format: Literal["zip"]

    @field_validator("path")
    @classmethod
    def portable_path(cls, value):
        return check_package_path(value)


def source_for(ctx, payload):
    source = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=payload.source_revision_id)
        .first()
    )
    if source is None:
        raise NotFound("Source revision not found.")
    authorize_revision(ctx.user, source, Perm.SOURCE_REGISTER)
    file = (
        source.files.select_related("blob")
        .filter(path=payload.path, blob__workspace_id=source.bundle.workspace_id)
        .first()
    )
    if file is None:
        raise NotFound("Preserved file not found.")
    if source.bundle.role != SourceBundle.Role.ORIGINAL:
        raise ValidationFailed("ZIP expansion requires a preserved original bundle revision.")
    return source, file


def replay_authority(ctx, payload, result):
    source_for(ctx, payload)
    derivative = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=result["revision_id"])
        .first()
    )
    if derivative is None:
        raise NotFound("Source revision not found.")
    authorize_revision(ctx.user, derivative)


def expansion_scope(ctx, payload):
    from specmate.operations.models import IdempotencyRecord

    source, _ = source_for(ctx, payload)
    scope = f"workspace:{source.bundle.workspace_id}"
    # Shared execution compares fingerprints after scope resolution. Check retained
    # output/parent authority here too, before even revealing a mismatch outcome.
    prior = IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user, operation="source.expand_zip", key=ctx.idempotency_key
    )
    retained = prior.filter(scope=scope).first()
    if retained is not None:
        replay_authority(ctx, payload, retained.result)
    return scope


@operation(
    "source.expand_zip",
    ExpandZip,
    summary="Expand a supported preserved ZIP into an inert derivative with exact ancestry.",
    idempotency_scope=expansion_scope,
    authorize_replay=replay_authority,
    access=Perm.SOURCE_REGISTER,
)
def expand_zip(ctx: Context, p: ExpandZip):
    source, file = source_for(ctx, p)
    if file.blob.size > min(zip_intake.MAX_ARCHIVE, settings.SPECMATE_MAX_SOURCE_BYTES):
        zip_intake.reject()
    try:
        with blobstore.open_blob(file.blob.sha256) as stream:
            data = stream.read(zip_intake.MAX_ARCHIVE + 1)
    except OSError:
        raise ValidationFailed("Preserved archive bytes are unavailable.") from None
    if len(data) != file.blob.size or hashlib.sha256(data).hexdigest() != file.blob.sha256:
        raise ValidationFailed("Preserved archive bytes failed integrity verification.")
    staged = zip_intake.stage_members(data, settings.SPECMATE_MAX_SOURCE_BYTES)
    try:
        files = []
        for member, item in staged:
            blobstore.promote(item)
            SourceBlob.objects.get_or_create(
                workspace_id=source.bundle.workspace_id,
                sha256=item.sha256,
                defaults={
                    "size": item.size,
                    "media_type": "application/octet-stream",
                    "registered_by": ctx.user,
                },
            )
            files.append(
                FileRef(
                    path=member.path,
                    sha256=item.sha256,
                    media_type="application/octet-stream",
                    rights=file.rights,
                )
            )
        bundle = SourceBundle.objects.create(
            workspace_id=source.bundle.workspace_id,
            name=p.name,
            role=SourceBundle.Role.DERIVATIVE,
            derived_from=source,
            created_by=ctx.user,
        )
        revision = _write_revision(ctx, bundle, files, [str(source.id)])
        SourceArchiveExpansion.objects.create(
            revision=revision, archive_file=file, parser="specmate-classic-zip-v1"
        )
        result = revision_result(revision)
        return {
            **result,
            "source_revision_id": str(source.id),
            "source_path": file.path,
            "source_sha256": file.blob.sha256,
            "rights": file.rights,
            "member_count": len(files),
            "expanded_bytes": sum(s.size for _, s in staged),
            "parser": "specmate-classic-zip-v1",
            "execution": "none",
        }
    finally:
        for _, item in staged:
            blobstore.discard(item)
