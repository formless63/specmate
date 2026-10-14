"""Later release warnings (EVD-005): append-only records beside an immutable release.

A warning references a release and optionally one of its pinned revisions and exact source
files. Superseding or withdrawing adds rows; nothing is edited or deleted, and the stored
approval record is never touched. Exports carry warnings in a separate file.
"""

import base64
import json

from django.db import transaction

from specmate.access.permissions import Perm, authorize, held_permissions
from specmate.design.operations import canonical_bytes
from specmate.export_packages.queries import digest
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)
from specmate.operations.scope import workspace_scope
from specmate.releases.contracts import ReleaseRef, WarnRelease, WithdrawWarning
from specmate.releases.models import ReleaseWarning, ReleaseWarningWithdrawal
from specmate.sources.models import SourceBundleFile

WARNINGS_FORMAT = "specmate.release_warnings"
WARNINGS_VERSION = "0.1"


def warning_state(warning):
    if hasattr(warning, "withdrawal"):
        return "withdrawn"
    if hasattr(warning, "superseded_by"):
        return "superseded"
    return "active"


def warning_view(warning):
    withdrawal = getattr(warning, "withdrawal", None)
    superseded_by = getattr(warning, "superseded_by", None)
    return {
        "warning_id": str(warning.id),
        "release_id": str(warning.release_id),
        "kind": warning.kind,
        "severity": warning.severity,
        "title": warning.title,
        "body": warning.body,
        "revision_id": str(warning.revision_id) if warning.revision_id else None,
        "source": (
            {
                "source_revision_id": str(warning.source_file.revision_id),
                "path": warning.source_file.path,
                "sha256": warning.source_file.blob_id,
            }
            if warning.source_file_id
            else None
        ),
        "assertion_id": str(warning.assertion_id) if warning.assertion_id else None,
        "origin": warning.origin,
        "state": warning_state(warning),
        "supersedes_id": str(warning.supersedes_id) if warning.supersedes_id else None,
        "superseded_by_id": str(superseded_by.id) if superseded_by else None,
        "withdrawal": (
            {
                "reason": withdrawal.reason,
                "withdrawn_by": withdrawal.withdrawn_by.get_username(),
                "withdrawn_at": withdrawal.created_at.isoformat(),
            }
            if withdrawal
            else None
        ),
        "author": warning.author.get_username(),
        "created_at": warning.created_at.isoformat(),
    }


def release_warnings(release):
    rows = (
        ReleaseWarning.objects.filter(release=release)
        .select_related("author", "source_file", "withdrawal__withdrawn_by", "superseded_by")
        .order_by("created_at", "id")
    )
    return [warning_view(row) for row in rows]


def active_count(views):
    return sum(1 for row in views if row["state"] == "active")


def _release_for_write(ctx, release_id, *, lock=False):
    from specmate.releases.models import Release

    query = Release.objects.select_for_update() if lock else Release.objects
    release = query.filter(id=release_id).first()
    if release is None:
        raise NotFound("Release not found.")
    authorize(ctx.user, release.workspace_id, Perm.ITEM_CREATE)
    return release


def warn_scope(ctx, p):
    release = _release_for_write(ctx, p.release_id)
    return workspace_scope(ctx, release.workspace_id, Perm.ITEM_CREATE)


def warn_replay(ctx, p, stored):
    authorize(ctx.user, stored["workspace_id"], Perm.ITEM_CREATE)


@operation(
    "release.warn",
    WarnRelease,
    summary="Attach a later contradiction, security or engineering warning to a release. "
    "The release record is not changed; the warning is a separate append-only row.",
    idempotency_scope=warn_scope,
    authorize_replay=warn_replay,
    access=Perm.ITEM_CREATE,
)
def warn(ctx: Context, p: WarnRelease):
    release = _release_for_write(ctx, p.release_id, lock=True)
    source_file = None
    if p.revision_id is not None and not release.pins.filter(revision_id=p.revision_id).exists():
        raise ValidationFailed("A warning references a revision pinned by the release.")
    if p.source_revision_id is not None:
        pinned = {
            (str(row["source_revision_id"]), row["path"])
            for row in release.record["review"]["dependencies"]["sources"]
        }
        if (str(p.source_revision_id), p.source_path) not in pinned:
            raise ValidationFailed("A warning references a source file pinned by the release.")
        source_file = SourceBundleFile.objects.get(
            revision_id=p.source_revision_id, path=p.source_path
        )
    superseded = None
    if p.supersedes_id is not None:
        superseded = (
            ReleaseWarning.objects.select_for_update()
            .filter(id=p.supersedes_id, release=release)
            .first()
        )
        if superseded is None:
            raise NotFound("Warning not found on this release.")
        if warning_state(superseded) != "active":
            raise Conflict("Only an active warning can be superseded.")
    warning = ReleaseWarning.objects.create(
        release=release,
        kind=p.kind,
        severity=p.severity,
        title=p.title,
        body=p.body,
        revision_id=p.revision_id,
        source_file=source_file,
        supersedes=superseded,
        author=ctx.user,
        request_id=ctx.request_id,
    )
    return {"workspace_id": str(release.workspace_id), **_view_one(warning.id)}


def _view_one(warning_id):
    warning = ReleaseWarning.objects.select_related(
        "author", "source_file", "withdrawal__withdrawn_by", "superseded_by"
    ).get(id=warning_id)
    return warning_view(warning)


def withdraw_scope(ctx, p):
    warning = ReleaseWarning.objects.select_related("release").filter(id=p.warning_id).first()
    if warning is None:
        raise NotFound("Warning not found.")
    return workspace_scope(ctx, warning.release.workspace_id, Perm.WORKSPACE_READ)


def withdraw_replay(ctx, p, stored):
    authorize(ctx.user, stored["workspace_id"], Perm.WORKSPACE_READ)


@operation(
    "release.withdraw_warning",
    WithdrawWarning,
    summary="Withdraw a release warning with a stated reason (author or workspace admin). "
    "The warning stays readable; nothing is deleted.",
    idempotency_scope=withdraw_scope,
    authorize_replay=withdraw_replay,
    access=Perm.ITEM_CREATE,
)
def withdraw(ctx: Context, p: WithdrawWarning):
    warning = (
        ReleaseWarning.objects.select_for_update()
        .select_related("release")
        .filter(id=p.warning_id)
        .first()
    )
    if warning is None:
        raise NotFound("Warning not found.")
    workspace_id = warning.release.workspace_id
    held = held_permissions(ctx.user, workspace_id)
    if Perm.ITEM_CREATE not in held:
        raise PermissionDenied(f"Missing permission {Perm.ITEM_CREATE.value}.")
    if warning.author_id != ctx.user.pk and Perm.WORKSPACE_ADMIN not in held:
        raise PermissionDenied("Only the author or a workspace admin can withdraw a warning.")
    if hasattr(warning, "withdrawal"):
        raise Conflict("The warning is already withdrawn.")
    ReleaseWarningWithdrawal.objects.create(
        warning=warning, reason=p.reason, withdrawn_by=ctx.user, request_id=ctx.request_id
    )
    return {"workspace_id": str(workspace_id), **_view_one(warning.id)}


@operation(
    "release.warnings",
    ReleaseRef,
    summary="List every warning attached to a release, including superseded and withdrawn.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def warnings(ctx: Context, p: ReleaseRef):
    from specmate.releases.operations import readable_release

    release = readable_release(ctx, p.release_id)
    views = release_warnings(release)
    return {"release_id": str(release.id), "warnings": views, "active": active_count(views)}


def warnings_file(release):
    views = release_warnings(release)
    return canonical_bytes(
        {
            "format": WARNINGS_FORMAT,
            "schema_version": WARNINGS_VERSION,
            "release_id": str(release.id),
            "release_record_sha256": release.record_sha256,
            "note": "Later warnings about this release. The release record and package "
            "archive are unchanged; withdrawn and superseded warnings are kept.",
            "warnings": views,
        }
    )


@operation(
    "release.export_warnings",
    ReleaseRef,
    summary="Export a release's warnings as a separate file; the archive stays exact.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def export_warnings(ctx: Context, p: ReleaseRef):
    from specmate.releases.operations import readable_release

    release = readable_release(ctx, p.release_id)
    data = warnings_file(release)
    return {
        "filename": "release-warnings.json",
        "media_type": "application/json",
        "content_base64": base64.b64encode(data).decode(),
        "sha256": digest(data),
        "release_record_sha256": release.record_sha256,
    }


def raise_for_assertion(subject, prior_rows, assertion):
    """Automatically warn releases that pin a revision when a new assertion contradicts.

    Called inside the appending transaction. The contradiction must be new: the same
    property/context group was not already conflicting before this assertion.
    """
    if subject.kind != "revision":
        return
    from specmate.facts.queries import assessments, group_key
    from specmate.releases.models import ReleasePin

    def conflicting(rows):
        key = group_key(assertion)
        return any(
            row["status"] == "conflicting" and group_key_of(row) == key
            for row in assessments(rows, assertion.property)
        )

    def group_key_of(row):
        return json.dumps(
            {"purpose": row["purpose"], "role": row["role"], "conditions": row.get("conditions")},
            sort_keys=True,
        )

    if not conflicting([*prior_rows, assertion]) or conflicting(prior_rows):
        return
    pins = ReleasePin.objects.filter(revision_id=subject.revision_id).select_related("release")
    with transaction.atomic():
        for pin in pins:
            ReleaseWarning.objects.get_or_create(
                release=pin.release,
                assertion=assertion,
                defaults={
                    "kind": "contradiction",
                    "severity": "caution",
                    "title": f"New contradicting assertion on {assertion.property}",
                    "body": (
                        f"A later {assertion.status} assertion on property "
                        f"'{assertion.property}' of pinned revision {subject.revision_id} "
                        "makes its recorded facts conflict. Review the fact ledger; the "
                        "release record is unchanged."
                    ),
                    "revision_id": subject.revision_id,
                    "origin": "automatic",
                    "author": assertion.actor,
                    "request_id": assertion.request_id,
                },
            )
