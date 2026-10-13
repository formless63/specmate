"""Fresh shared authority and atomic immutable output registration, without native tools."""

import base64
import io

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import LEGACY_SCOPE
from specmate.preparation_documents.contracts import GENERATOR, Configuration, Download, SetRef
from specmate.preparation_documents.models import DocumentOutput, DocumentSet
from specmate.preparation_documents.projection import authorize_inputs, project
from specmate.preparation_documents.rendering import MAX_FILE_BYTES, render
from specmate.sources import blobstore


def configuration_scope(ctx, p):
    user, captured, _, _ = authorize_inputs(ctx.user, p)
    root = captured[p.root_revision_id]
    authorize(user, root.definition.project_id, Perm.DESIGN_EDIT)
    namespace = f"project:{root.definition.project_id}"
    if ctx.idempotency_key is not None:
        # A changed request may omit inputs still protected by its retained receipt.
        # Scope runs before the shared executor exposes key/CAS diagnostics.
        for prior in IdempotencyRecord.objects.filter(
            actor=user,
            operation="preparation_documents.generate",
            key=ctx.idempotency_key,
            scope__in=[namespace, LEGACY_SCOPE],
        ):
            authorized_set(user, prior.result["document_set_id"], Perm.DESIGN_EDIT)
    return namespace


def authorized_set(user, set_id, permission=Perm.PROJECT_READ):
    user = current_actor(user)
    record = (
        DocumentSet.objects.select_related("root_revision__definition").filter(id=set_id).first()
    )
    if record is None:
        raise NotFound("Document set not found.")
    authorize(user, record.root_revision.definition.project_id, permission)
    authorize_inputs(user, Configuration.model_validate(record.configuration))
    return record


def result(record):
    return {
        "document_set_id": str(record.id),
        "manifest": record.manifest,
        "sha256": record.sha256,
        "generator": record.generator,
        "created_by_id": record.created_by_id,
        "created_at": record.created_at.isoformat(),
    }


def replay(ctx, p, stored):
    configuration_scope(ctx, p)
    authorized_set(ctx.user, stored["document_set_id"], Perm.DESIGN_EDIT)


@operation(
    "preparation_documents.review",
    Configuration,
    supports_idempotency=False,
    summary="Review six documents against one exact immutable root and explicit bindings.",
)
def review(ctx: Context, p: Configuration):
    projection = project(ctx.user, p)
    manifest, _ = render(projection)
    return {"manifest": manifest, "state": "document-inputs-" + projection["inputs_sha256"]}


@operation(
    "preparation_documents.generate",
    Configuration,
    requires_expected_state=True,
    idempotency_scope=configuration_scope,
    authorize_replay=replay,
    summary="Retain a reviewed coherent immutable document set with identical input provenance.",
)
def generate(ctx: Context, p: Configuration):
    configuration_scope(ctx, p)
    if ctx.idempotency_key is None:
        raise ValidationFailed("Document generation requires a stable idempotency key.")
    projection = project(ctx.user, p)
    state = "document-inputs-" + projection["inputs_sha256"]
    if ctx.require_expected_state() != state:
        raise Conflict(
            "Document inputs changed since review; no output set was registered.",
            details={"current_state": state},
        )
    manifest, files = render(projection)
    staged = []
    try:
        # Promote all bytes before publishing DB references. A rolled-back transaction
        # may leave unreferenced content-addressed bytes, as in shared source storage;
        # it can never expose a partial set or a dangling successful receipt.
        for name, (_, data) in sorted(files.items()):
            blob = blobstore.stage(io.BytesIO(data), MAX_FILE_BYTES)
            staged.append(blob)
            expected = next(o for o in manifest["outputs"] if o["filename"] == name)
            if blob.sha256 != expected["sha256"] or blob.size != expected["size"]:
                raise ValidationFailed("Generated document integrity mismatch.")
        for blob in staged:
            blobstore.promote(blob)
        record = DocumentSet.objects.create(
            root_revision_id=p.root_revision_id,
            configuration=p.model_dump(mode="json"),
            manifest=manifest,
            sha256=projection["inputs_sha256"],
            generator=GENERATOR,
            created_by=ctx.user,
            request_id=ctx.request_id,
        )
        DocumentOutput.objects.bulk_create(
            [
                DocumentOutput(
                    document_set=record,
                    filename=o["filename"],
                    media_type=o["media_type"],
                    sha256=o["sha256"],
                    size=o["size"],
                    rights=o["rights"],
                )
                for o in manifest["outputs"]
            ]
        )
        return result(record)
    finally:
        for blob in staged:
            blobstore.discard(blob)


@operation(
    "preparation_documents.read",
    SetRef,
    supports_idempotency=False,
    summary="Read an immutable document receipt after fresh complete input closure authorization.",
)
def read(ctx: Context, p: SetRef):
    return result(authorized_set(ctx.user, p.document_set_id))


@operation(
    "preparation_documents.download",
    Download,
    supports_idempotency=False,
    summary="Download retained exact document bytes under fresh current input authority.",
)
def download(ctx: Context, p: Download):
    record = authorized_set(ctx.user, p.document_set_id)
    output = record.outputs.filter(filename=p.filename).first()
    if output is None:
        raise NotFound("Document output not found.")
    with blobstore.open_blob(output.sha256) as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    from specmate.selected_packages.queries import digest

    if len(data) != output.size or digest(data) != output.sha256:
        raise ValidationFailed("Retained document integrity mismatch.")
    return {
        "document_set_id": str(record.id),
        "filename": output.filename,
        "media_type": output.media_type,
        "sha256": output.sha256,
        "size": output.size,
        "rights": output.rights,
        "inputs_sha256": record.sha256,
        "data_base64": base64.b64encode(data).decode(),
    }
