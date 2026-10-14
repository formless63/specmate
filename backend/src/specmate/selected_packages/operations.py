"""Fresh review/download operations for GUI, API, MCP and trusted jobs."""

import base64

from specmate.access.permissions import Perm
from specmate.operations import Context, operation
from specmate.selected_packages.contracts import Download, Selection
from specmate.selected_packages.queries import archive, build_package, digest


@operation(
    "selected_package.review",
    Selection,
    summary="Review exact selected assembly data, boundaries, rights and unresolved dependencies.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def review(ctx: Context, p: Selection):
    manifest, _, sha256 = build_package(ctx.user, p)
    return {"manifest": manifest, "sha256": sha256}


@operation(
    "selected_package.download",
    Download,
    summary="Download a freshly authorized inert package matching an explicit review hash.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def download(ctx: Context, p: Download):
    data, manifest_sha256, _ = archive(ctx.user, p)
    return {
        "archive_base64": base64.b64encode(data).decode(),
        "sha256": digest(data),
        "manifest_sha256": manifest_sha256,
        "media_type": "application/zip",
    }
