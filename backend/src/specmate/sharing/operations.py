"""Record and list workspace-external hand-offs (KNW-004).

Downloads of export packages, selected packages and release archives call ``record_share``
in the same operation, so every copy that leaves the workspace has a who/what/when row.
Any workspace member sees every record.
"""

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Revision
from specmate.operations import Context, operation
from specmate.sharing.contracts import ListShares
from specmate.sharing.models import ShareRecord


def record_share(
    ctx: Context,
    *,
    kind,
    root_revision_id,
    purpose,
    archive_sha256,
    manifest_sha256,
    release_id=None,
):
    workspace_id = Revision.objects.values_list("definition__workspace_id", flat=True).get(
        id=root_revision_id
    )
    return ShareRecord.objects.create(
        workspace_id=workspace_id,
        kind=kind,
        root_revision_id=root_revision_id,
        release_id=release_id,
        purpose=purpose,
        archive_sha256=archive_sha256,
        manifest_sha256=manifest_sha256,
        shared_by=ctx.user,
        via=ctx.via,
    )


def view(row):
    return {
        "id": str(row.id),
        "kind": row.kind,
        "root_revision_id": str(row.root_revision_id),
        "release_id": str(row.release_id) if row.release_id else None,
        "purpose": row.purpose,
        "archive_sha256": row.archive_sha256,
        "manifest_sha256": row.manifest_sha256,
        "shared_by": row.shared_by_id,
        "shared_at": row.shared_at.isoformat(),
        "via": row.via,
    }


@operation(
    "share.list",
    ListShares,
    summary="List recorded workspace-external hand-offs (who shared what, when).",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def list_shares(ctx: Context, p: ListShares):
    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_READ)
    rows = ShareRecord.objects.filter(workspace=workspace)
    total = rows.count()
    window = list(rows.order_by("-shared_at", "-id")[p.offset : p.offset + p.limit])
    return {
        "workspace_id": str(workspace.id),
        "shares": [view(r) for r in window],
        "total": total,
        "offset": p.offset,
        "limit": p.limit,
    }
