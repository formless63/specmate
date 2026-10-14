"""Release review, creation and retrieval for GUI, API, MCP and trusted jobs (EVD-004).

``release.review`` computes the closure without writing. ``release.create`` recomputes it,
refuses a review that changed since the actor saw it (so a new model or pack revision is
never adopted silently), refuses blockers, requires an explicit acknowledgement with a
reason for unresolved items, and stores one immutable record plus the exact package
archive. Reads and downloads apply current access; a release is not public permission.
"""

import base64
import io

from django.db import transaction
from django.utils import timezone

from specmate.access.models import ProjectReference
from specmate.access.permissions import Perm, authorize, authorize_project, context_project
from specmate.design.models import Revision
from specmate.design.operations import canonical_bytes
from specmate.export_packages.contracts import ExportRequest
from specmate.export_packages.queries import LATEST_FORMAT, build_package, digest, zip_package
from specmate.export_packages.verification import verify_archive
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.scope import workspace_scope
from specmate.queries import get_revision
from specmate.releases.closure import review_digest, review_release
from specmate.releases.contracts import CreateRelease, ListReleases, ReleaseRef, ReleaseReview
from specmate.releases.models import Release, ReleaseConfiguration, ReleasePin
from specmate.sharing.operations import record_share
from specmate.sources import blobstore

RECORD_FORMAT = "specmate.release"
RECORD_VERSION = "0.1"
MAX_ARCHIVE = 32 * 1024 * 1024


@operation(
    "release.review",
    ReleaseReview,
    summary="Review one exact root's release closure: revisions, configurations, dependencies, "
    "artifacts, rights, evidence applicability, unresolved items and blockers.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def review(ctx: Context, p: ReleaseReview):
    closure, _, _ = review_release(ctx, p)
    return {"review": closure, "sha256": review_digest(closure)}


def root_workspace(ctx, revision_id, permission):
    revision = Revision.objects.select_related("definition").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Revision not found.")
    return authorize(ctx.user, revision.definition.workspace_id, permission)


def create_scope(ctx, p):
    workspace = root_workspace(ctx, p.root_revision_id, Perm.DESIGN_FREEZE)
    return workspace_scope(ctx, workspace.id, Perm.DESIGN_FREEZE)


def create_replay(ctx, p, stored):
    authorize(ctx.user, stored["workspace_id"], Perm.DESIGN_FREEZE)


def store_archive(data):
    staged = blobstore.stage(io.BytesIO(data), MAX_ARCHIVE)
    blobstore.promote(staged)
    return staged


@operation(
    "release.create",
    CreateRelease,
    summary="Freeze a reviewed release closure; unresolved items need an explicit "
    "acknowledgement with a reason. The record is immutable.",
    idempotency_scope=create_scope,
    authorize_replay=create_replay,
    access=Perm.DESIGN_FREEZE,
)
def create(ctx: Context, p: CreateRelease):
    workspace = root_workspace(ctx, p.root_revision_id, Perm.DESIGN_FREEZE)
    project = None
    if p.project_id is not None:
        project = context_project(p.project_id, workspace)
        authorize_project(ctx.user, project.id, Perm.PROJECT_EDIT)
        if project.archived_at is not None:
            raise Conflict("Archived projects are read-only; unarchive the project first.")
    # Fixed once, before the manifest is built, and stored: create and verify bound build
    # reproducibility evidence to the same instant, so a comparison committed later
    # cannot change the reconstructed manifest.
    as_of = timezone.now()
    closure, files, manifest_sha256 = review_release(
        ctx, p, as_of=as_of, package_format=LATEST_FORMAT
    )
    sha256 = review_digest(closure)
    if sha256 != p.reviewed_sha256:
        raise Conflict(
            "The release closure changed since review; review the exact request again.",
            details={"current_sha256": sha256},
        )
    if closure["blockers"]:
        raise ValidationFailed(
            "Required blockers prevent this release.",
            details={"blockers": [row["id"] for row in closure["blockers"]]},
        )
    unresolved = closure["unresolved"]
    if unresolved and p.acknowledgement is None:
        raise ValidationFailed(
            "Releasing with unresolved items requires an explicit acknowledgement and reason.",
            details={"unresolved": len(unresolved)},
        )
    data = zip_package(files)
    problems = verify_archive(data, manifest_sha256)
    if problems:
        raise ValidationFailed(
            "The release package failed verification.", details={"problems": problems}
        )
    record = {
        "format": RECORD_FORMAT,
        "schema_version": RECORD_VERSION,
        "name": p.name,
        "notes": p.notes,
        "review": closure,
        "review_sha256": sha256,
        "archive": {
            "sha256": digest(data),
            "bytes": len(data),
            "media_type": "application/zip",
            "manifest_sha256": manifest_sha256,
        },
        "acknowledgement": (
            {
                "reason": p.acknowledgement.reason,
                "unresolved_ids": [row["id"] for row in unresolved],
            }
            if p.acknowledgement
            else None
        ),
        "released_by": ctx.user.get_username(),
        "request_id": ctx.request_id,
    }
    raw = canonical_bytes(record)
    roles = {row["revision_id"]: row["role"] for row in closure["revisions"]}
    roles.update({row["revision_id"]: row["role"] for row in closure["dependencies"]["revisions"]})
    shas = {row["revision_id"]: row["snapshot_sha256"] for row in closure["revisions"]}
    shas.update(
        {row["revision_id"]: row["snapshot_sha256"] for row in closure["dependencies"]["revisions"]}
    )
    store_archive(data)
    with transaction.atomic():
        release = Release.objects.create(
            workspace=workspace,
            name=p.name,
            root_revision_id=p.root_revision_id,
            request=p.model_dump(mode="json", exclude={"reviewed_sha256", "acknowledgement"}),
            record=record,
            record_canonical=raw,
            record_sha256=digest(raw),
            review_sha256=sha256,
            manifest_sha256=manifest_sha256,
            archive_sha256=record["archive"]["sha256"],
            archive_bytes=len(data),
            unresolved_count=len(unresolved),
            acknowledgement_reason=p.acknowledgement.reason if p.acknowledgement else "",
            released_by=ctx.user,
            request_id=ctx.request_id,
            reproducibility_as_of=as_of,
            package_format=LATEST_FORMAT,
        )
        ReleasePin.objects.bulk_create(
            ReleasePin(release=release, revision_id=rid, role=role, sha256=shas[rid])
            for rid, role in sorted(roles.items())
        )
        ReleaseConfiguration.objects.bulk_create(
            ReleaseConfiguration(
                release=release,
                configuration_id=row["resolved_configuration_id"],
                resolution_sha256=row["resolution_sha256"],
            )
            for row in closure["configurations"]
        )
        if project is not None:
            ProjectReference.objects.create(
                project=project,
                kind="release",
                release=release,
                role="release",
                added_by=ctx.user,
                request_id=ctx.request_id,
            )
    return release_view(Release.objects.get(id=release.id))


def summary(release):
    review = release.record["review"]
    return {
        "release_id": str(release.id),
        "workspace_id": str(release.workspace_id),
        "name": release.name,
        "root": review["root"],
        "status": review["status"],
        "unresolved_count": release.unresolved_count,
        "acknowledged": bool(release.acknowledgement_reason),
        "record_sha256": release.record_sha256,
        "released_by": release.record["released_by"],
        "released_at": release.released_at.isoformat(),
        "active_warnings": release.warnings.filter(
            withdrawal__isnull=True, superseded_by__isnull=True
        ).count(),
    }


def release_view(release):
    from specmate.releases.warnings import release_warnings

    warnings = release_warnings(release)
    # The stored approval record is returned as recorded. Later observations about the
    # release (EVD-005) are separate records and never edited into ``record``.
    return {
        **summary(release),
        "record": release.record,
        "review_sha256": release.review_sha256,
        "archive_sha256": release.archive_sha256,
        "archive_bytes": release.archive_bytes,
        # Later warnings (EVD-005), shown beside the unchanged record.
        "warnings": warnings,
    }


def readable_release(ctx, release_id):
    release = (
        Release.objects.select_related("workspace", "root_revision").filter(id=release_id).first()
    )
    if release is None:
        raise NotFound("Release not found.")
    authorize(ctx.user, release.workspace_id, Perm.WORKSPACE_READ)
    return release


@operation(
    "release.read",
    ReleaseRef,
    summary="Read one immutable release record as it was approved.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read(ctx: Context, p: ReleaseRef):
    return release_view(readable_release(ctx, p.release_id))


@operation(
    "release.list",
    ListReleases,
    summary="List a workspace's releases, optionally those a project references.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def list_releases(ctx: Context, p: ListReleases):
    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_READ)
    rows = Release.objects.filter(workspace=workspace)
    project = context_project(p.project_id, workspace)
    if project is not None:
        rows = rows.filter(
            id__in=ProjectReference.objects.filter(
                project=project, kind="release", removed_at__isnull=True
            ).values("release_id")
        )
    total = rows.count()
    window = list(rows.order_by("-released_at", "-id")[p.offset : p.offset + p.limit])
    return {
        "workspace_id": str(workspace.id),
        "project_id": str(project.id) if project else None,
        "releases": [summary(row) for row in window],
        "total": total,
        "offset": p.offset,
        "limit": p.limit,
    }


def stored_archive(release):
    try:
        with blobstore.open_blob(release.archive_sha256) as stream:
            data = stream.read(MAX_ARCHIVE + 1)
    except OSError:
        return None
    return data


@operation(
    "release.verify",
    ReleaseRef,
    summary="Verify a release is intact and reconstructable from its exact pins and archive.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def verify(ctx: Context, p: ReleaseRef):
    release = readable_release(ctx, p.release_id)
    problems = []
    if digest(bytes(release.record_canonical)) != release.record_sha256:
        problems.append("release record bytes differ from their recorded hash")
    data = stored_archive(release)
    if data is None:
        problems.append("release archive unavailable")
    elif len(data) != release.archive_bytes or digest(data) != release.archive_sha256:
        problems.append("release archive bytes differ from their recorded hash")
    else:
        problems.extend(verify_archive(data, release.manifest_sha256))
    for pin in release.pins.select_related("revision__snapshot"):
        if pin.revision.snapshot.sha256 != pin.sha256:
            problems.append(f"pinned revision bytes differ: {pin.revision_id}")
    for row in release.configurations.select_related("configuration"):
        if row.configuration.resolution_sha256 != row.resolution_sha256:
            problems.append(f"resolved configuration differs: {row.configuration_id}")
    # Reconstruction: the stored request rebuilt from the same exact pins must reproduce
    # the same manifest under current authority. Rebuilding never adopts newer revisions.
    try:
        request = ExportRequest.model_validate(
            {k: release.request[k] for k in ExportRequest.model_fields if k in release.request}
        )
        get_revision(ctx.user, release.root_revision_id)
        _, _, rebuilt = build_package(
            ctx, request, as_of=release.reproducibility_as_of, package_format=release.package_format
        )
        reconstruction = "identical" if rebuilt == release.manifest_sha256 else "differs"
    except NotFound:
        reconstruction = "unavailable"
    except ValidationFailed as error:
        reconstruction = "unavailable"
        problems.append(f"reconstruction failed: {error}")
    if reconstruction == "differs":
        problems.append("rebuilding the release request produces a different manifest")
    return {
        "release_id": str(release.id),
        "status": "verified" if not problems else "problems",
        "reconstruction": reconstruction,
        "problems": problems,
        "pins": release.pins.count(),
        "configurations": release.configurations.count(),
    }


@operation(
    "release.download",
    ReleaseRef,
    summary="Download a release's exact retained package archive under current access.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def download(ctx: Context, p: ReleaseRef):
    release = readable_release(ctx, p.release_id)
    get_revision(ctx.user, release.root_revision_id)
    data = stored_archive(release)
    if data is None or digest(data) != release.archive_sha256:
        raise ValidationFailed("The retained release archive is unavailable or altered.")
    record_share(
        ctx,
        kind="release",
        root_revision_id=release.root_revision_id,
        release_id=release.id,
        purpose="release",
        archive_sha256=release.archive_sha256,
        manifest_sha256=release.manifest_sha256,
    )
    return {
        "archive_base64": base64.b64encode(data).decode(),
        "sha256": release.archive_sha256,
        "manifest_sha256": release.manifest_sha256,
        "media_type": "application/zip",
    }
