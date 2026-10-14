"""Fresh review/download operations for GUI, API, MCP and trusted jobs (DOC-001)."""

import base64

from specmate.access.permissions import Perm
from specmate.export_packages.candidates import candidates as list_candidates
from specmate.export_packages.contracts import Candidates, Download, ExportRequest
from specmate.export_packages.queries import archive, build_package, digest
from specmate.operations import Context, operation


@operation(
    "export_package.review",
    ExportRequest,
    summary="Review one exact root's system/cable/PCB/mechanical/spreadsheet/test outputs, "
    "their cited revisions and independently derived scope quantities.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def review(ctx: Context, p: ExportRequest):
    manifest, _, sha256 = build_package(ctx, p)
    return {"manifest": manifest, "sha256": sha256}


@operation(
    "export_package.download",
    Download,
    summary="Download a freshly authorized coherent export package matching its review hash.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def download(ctx: Context, p: Download):
    data, manifest_sha256, _ = archive(ctx, p)
    return {
        "archive_base64": base64.b64encode(data).decode(),
        "sha256": digest(data),
        "manifest_sha256": manifest_sha256,
        "media_type": "application/zip",
    }


@operation(
    "export_package.candidates",
    Candidates,
    summary="List currently readable retained outputs that may belong to one root's closure.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def candidates(ctx: Context, p: Candidates):
    return list_candidates(ctx, p)
