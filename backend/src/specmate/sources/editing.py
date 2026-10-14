"""Native editing handoff: export an exact revision, review edited bytes, re-enter them.

Export is a deterministic classic stored ZIP of an exact revision plus a reserved,
informational handoff marker. Re-entry never merges or overwrites: a reviewed change
set becomes a separate derivative, or the next revision of a derivative whose head is
still the baseline. Imported files stay inert; this is not native validation.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from typing import Literal
from uuid import UUID

from django.conf import settings
from django.db.models import Max
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from specmate.access.permissions import Perm
from specmate.contracts import SHA256, check_file_tree, check_package_path
from specmate.design.operations import canonical_bytes
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.sources import blobstore, zip_intake
from specmate.sources.authority import authorize_revision
from specmate.sources.models import (
    SourceBlob,
    SourceBundle,
    SourceBundleFile,
    SourceBundleRevision,
    SourceEditSubmission,
)
from specmate.sources.operations import FileRef, _write_revision, bundle_state, revision_result

MARKER = "SPECMATE-HANDOFF.json"
MARKER_FORMAT = "specmate-source-handoff-v1"
MAX_MARKER = 1024 * 1024
PARSER = "specmate-classic-zip-v1"
OCTET = "application/octet-stream"
NOTICE = (
    "Exported for editing outside Specmate. Files are inert copies of the exact baseline; "
    "this marker only identifies the baseline and grants no authority. Re-entry creates a "
    "reviewed derivative; it is not native validation or physical qualification."
)
# Common operating-system/editor by-products. Only suggested for exclusion, never dropped.
ARTIFACT = re.compile(
    r"(^|/)(__MACOSX|\.git|\.svn|\.hg|[^/]*-backups)/|(^|/)(\.DS_Store|Thumbs\.db|desktop\.ini|"
    r"\._[^/]*|~\$[^/]*|[^/]*~|[^/]*\.(bak|lck|tmp|swp)|_autosave-[^/]*|#auto_saved_files#)$",
    re.IGNORECASE,
)


def _reserved(path: str) -> bool:
    return path.rsplit("/", 1)[-1].casefold() == MARKER.casefold()


# ---------------------------------------------------------------- export


def export_handoff(revision: SourceBundleRevision) -> tuple[bytes, str]:
    """Caller authorizes the revision closure first. Returns ZIP bytes and filename."""
    files = list(revision.files.select_related("blob").order_by("path"))
    if any(_reserved(f.path) for f in files):
        raise ValidationFailed(
            f"This revision contains the reserved path {MARKER}; download its files individually."
        )
    if len(files) + 1 > zip_intake.MAX_ENTRIES or any(
        f.blob.size > zip_intake.MAX_MEMBER for f in files
    ):
        raise ValidationFailed("This revision exceeds the editing handoff re-entry limits.")
    if sum(f.blob.size for f in files) > zip_intake.MAX_ARCHIVE:
        raise ValidationFailed("This revision exceeds the editing handoff re-entry limits.")
    marker = {
        "format": MARKER_FORMAT,
        "baseline_revision_id": str(revision.id),
        "bundle_id": str(revision.bundle_id),
        "bundle_name": revision.bundle.name,
        "revision_number": revision.number,
        "manifest_sha256": revision.manifest_sha256,
        "files": [
            {"path": f.path, "sha256": f.blob.sha256, "bytes": f.blob.size, "rights": f.rights}
            for f in files
        ],
        "notice": NOTICE,
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for path, read in [(f.path, f.blob) for f in files] + [(MARKER, None)]:
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, canonical_bytes(marker) if read is None else _verified(read))
    data = buffer.getvalue()
    if len(data) > zip_intake.MAX_ARCHIVE:
        raise ValidationFailed("This revision exceeds the editing handoff re-entry limits.")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", revision.bundle.name).strip("-.")[:80] or "source"
    return data, f"{stem}-r{revision.number}-handoff.zip"


def _verified(blob: SourceBlob, limit: int | None = None) -> bytes:
    try:
        with blobstore.open_blob(blob.sha256) as stream:
            data = stream.read((limit or blob.size) + 1)
    except OSError:
        raise ValidationFailed("Preserved source bytes are unavailable.") from None
    if len(data) != blob.size or hashlib.sha256(data).hexdigest() != blob.sha256:
        raise ValidationFailed("Preserved source bytes failed integrity verification.")
    return data


# ---------------------------------------------------------------- re-entry payloads


class _PathEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(max_length=512)

    @field_validator("path")
    @classmethod
    def portable_path(cls, value: str) -> str:
        return check_package_path(value)


class EditedFile(_PathEntry):
    sha256: str = Field(pattern=SHA256)


class ArchiveRef(_PathEntry):
    revision_id: UUID


class RightsDeclaration(_PathEntry):
    rights: str = Field(min_length=1, max_length=200)


class EditInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    baseline_revision_id: UUID
    files: list[EditedFile] | None = Field(default=None, min_length=1, max_length=10000)
    archive: ArchiveRef | None = None
    rights: list[RightsDeclaration] = Field(default_factory=list, max_length=10000)
    exclude_paths: list[str] = Field(default_factory=list, max_length=10000)

    @field_validator("exclude_paths")
    @classmethod
    def portable_exclusions(cls, values):
        return [check_package_path(v) for v in values]

    @model_validator(mode="after")
    def one_input(self):
        if (self.files is None) == (self.archive is None):
            raise ValueError("provide exactly one of files or archive")
        if len({d.path for d in self.rights}) != len(self.rights):
            raise ValueError("rights declarations must name each path once")
        return self


class SubmitEdit(EditInput):
    target: Literal["new_derivative", "next_revision"]
    name: str | None = Field(default=None, min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=2000)
    reviewed_sha256: str = Field(pattern=SHA256)

    @model_validator(mode="after")
    def named_derivative(self):
        if (self.target == "new_derivative") != (self.name is not None):
            raise ValueError("name is required for, and only for, a new derivative")
        return self


# ---------------------------------------------------------------- scope and closure


def _baseline(ctx: Context, p: EditInput) -> SourceBundleRevision:
    baseline = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=p.baseline_revision_id)
        .first()
    )
    if baseline is None:
        raise NotFound("Source revision not found.")
    authorize_revision(ctx.user, baseline, Perm.SOURCE_REGISTER)
    return baseline


def _archive(
    ctx: Context, p: EditInput, baseline, *, authority_only: bool = False
) -> SourceBundleFile | None:
    if p.archive is None:
        return None
    revision = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=p.archive.revision_id)
        .first()
    )
    if revision is None:
        raise NotFound("Source revision not found.")
    authorize_revision(ctx.user, revision, Perm.SOURCE_REGISTER)
    if revision.bundle.workspace_id != baseline.bundle.workspace_id:
        raise NotFound("Source revision not found.")
    file = (
        revision.files.select_related("blob")
        .filter(path=p.archive.path, blob__workspace_id=baseline.bundle.workspace_id)
        .first()
    )
    if file is None:
        raise NotFound("Preserved file not found.")
    if not authority_only and revision.bundle.role != SourceBundle.Role.ORIGINAL:
        raise ValidationFailed("An edited ZIP must first be preserved as an original bundle.")
    return file


def _closure(ctx: Context, p: EditInput, *, authority_only: bool = False):
    baseline = _baseline(ctx, p)
    return baseline, _archive(ctx, p, baseline, authority_only=authority_only)


def _replay_authority(ctx: Context, p: SubmitEdit, result) -> None:
    _closure(ctx, p, authority_only=True)
    produced = (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(id=result["revision_id"])
        .first()
    )
    if produced is None:
        raise NotFound("Source revision not found.")
    authorize_revision(ctx.user, produced)


def _submit_scope(ctx: Context, p: SubmitEdit) -> str:
    from specmate.operations.models import IdempotencyRecord

    baseline, _ = _closure(ctx, p, authority_only=True)
    scope = f"workspace:{baseline.bundle.workspace_id}"
    # Check a retained outcome's complete closure before revealing even a mismatch.
    prior = IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user, operation="source.submit_edit", key=ctx.idempotency_key
    )
    retained = prior.filter(scope=scope).first()
    if retained is not None:
        _replay_authority(ctx, p, retained.result)
    return scope


# ---------------------------------------------------------------- review


class _Candidate:
    __slots__ = ("path", "sha256", "size", "staged")

    def __init__(self, path, sha256, size, staged=None):
        self.path, self.sha256, self.size, self.staged = path, sha256, size, staged


def _candidates(p: EditInput, baseline, archive):
    """Return candidate files and staged items (caller discards them)."""
    if archive is not None:
        if archive.blob.size > min(zip_intake.MAX_ARCHIVE, settings.SPECMATE_MAX_SOURCE_BYTES):
            zip_intake.reject()
        data = _verified(archive.blob, zip_intake.MAX_ARCHIVE)
        staged = zip_intake.stage_members(data, settings.SPECMATE_MAX_SOURCE_BYTES)
        return [_Candidate(m.path, s.sha256, s.size, s) for m, s in staged], staged
    try:
        check_file_tree([f.path for f in p.files], max_depth=32)
    except ValueError as exc:
        raise ValidationFailed(f"Invalid edited file tree: {exc}.") from None
    blobs = {
        b.sha256: b
        for b in SourceBlob.objects.filter(
            workspace_id=baseline.bundle.workspace_id, sha256__in={f.sha256 for f in p.files}
        )
    }
    missing = sorted(f.path for f in p.files if f.sha256 not in blobs)
    if missing:
        raise ValidationFailed(
            "Edited files reference bytes not registered in this project.",
            details={"paths": missing[:50]},
        )
    return [_Candidate(f.path, f.sha256, blobs[f.sha256].size) for f in p.files], []


def _marker(candidates, baseline, workspace_id):
    markers = [c for c in candidates if _reserved(c.path)]
    if not markers:
        return "absent", "", candidates
    if len(markers) > 1 or markers[0].path.count("/") > 1:
        raise ValidationFailed(f"Use one {MARKER} at the edited bundle root.")
    marker = markers[0]
    prefix = marker.path[: -len(MARKER)]
    if prefix and not all(c.path.startswith(prefix) for c in candidates):
        raise ValidationFailed(f"Files outside the folder containing {MARKER} are ambiguous.")
    if marker.size > MAX_MARKER:
        raise ValidationFailed("The handoff marker is not a valid Specmate handoff marker.")
    if marker.staged is not None:
        with marker.staged.path.open("rb") as stream:
            raw = stream.read()
    else:
        blob = SourceBlob.objects.get(workspace_id=workspace_id, sha256=marker.sha256)
        raw = _verified(blob)
    try:
        value = json.loads(raw)
        exported = value["baseline_revision_id"] if value.get("format") == MARKER_FORMAT else None
    except (ValueError, TypeError, KeyError, AttributeError):
        exported = None
    if not isinstance(exported, str):
        raise ValidationFailed("The handoff marker is not a valid Specmate handoff marker.")
    if exported != str(baseline.id):
        raise Conflict(
            "These edited files were exported from a different revision than the selected "
            "baseline. Select that baseline or remove the marker deliberately.",
            details={"exported_from": exported},
        )
    rest = [c for c in candidates if c is not marker]
    for c in rest:
        c.path = c.path[len(prefix) :]
    return "matched", prefix.rstrip("/"), rest


def review(p: EditInput, baseline, archive):
    """Compute the exact reviewed change set. Returns (review dict, final entries, staged)."""
    candidates, staged = _candidates(p, baseline, archive)
    try:
        marker, prefix, candidates = _marker(candidates, baseline, baseline.bundle.workspace_id)
        present = {c.path for c in candidates}
        unknown = sorted(set(p.exclude_paths) - present)
        if unknown:
            raise ValidationFailed(
                "Exclusions must name edited paths.", details={"paths": unknown[:50]}
            )
        base = {f.path: f for f in baseline.files.select_related("blob")}
        excluded = set(p.exclude_paths)
        kept = [c for c in candidates if c.path not in excluded]
        declared = {d.path: d.rights for d in p.rights}
        undeclared = sorted(set(declared) - {c.path for c in kept})
        if undeclared:
            raise ValidationFailed(
                "Rights declarations must name submitted paths.",
                details={"paths": undeclared[:50]},
            )
        entries = []
        for c in sorted(kept, key=lambda c: c.path):
            prior = base.get(c.path)
            rights = declared.get(c.path) or (prior.rights if prior else None)
            if prior is None:
                change = "added"
            elif prior.blob.sha256 != c.sha256:
                change = "modified"
            elif rights != prior.rights:
                change = "rights_changed"
            else:
                change = "unchanged"
            entries.append(
                {
                    "path": c.path,
                    "change": change,
                    "sha256": c.sha256,
                    "bytes": c.size,
                    "baseline_sha256": prior.blob.sha256 if prior else None,
                    "media_type": prior.media_type if prior else OCTET,
                    "rights": rights,
                    "rights_source": "declared"
                    if c.path in declared
                    else ("baseline" if prior else "missing"),
                    "suggested_exclusion": prior is None and bool(ARTIFACT.search(c.path)),
                }
            )
        removed = [
            {"path": path, "baseline_sha256": f.blob.sha256, "rights": f.rights}
            for path, f in sorted(base.items())
            if path not in {e["path"] for e in entries}
        ]
        excluded_rows = [
            {
                "path": c.path,
                "sha256": c.sha256,
                "bytes": c.size,
                "suggested_exclusion": bool(ARTIFACT.search(c.path)),
            }
            for c in sorted(candidates, key=lambda c: c.path)
            if c.path in excluded
        ]
        source = (
            {
                "kind": "zip",
                "revision_id": str(archive.revision_id),
                "path": archive.path,
                "sha256": archive.blob.sha256,
                "parser": PARSER,
            }
            if archive
            else {"kind": "files"}
        )
        material = {
            "baseline_revision_id": str(baseline.id),
            "baseline_manifest_sha256": baseline.manifest_sha256,
            "source": source,
            "marker": marker,
            "root_prefix": prefix,
            "files": [
                {k: e[k] for k in ("path", "sha256", "bytes", "media_type", "rights")}
                for e in entries
            ],
            "removed": [r["path"] for r in removed],
            "excluded": [r["path"] for r in excluded_rows],
        }
        counts = {
            kind: sum(1 for e in entries if e["change"] == kind)
            for kind in ("added", "modified", "rights_changed", "unchanged")
        }
        counts.update(removed=len(removed), excluded=len(excluded_rows))
        missing = [e["path"] for e in entries if e["rights"] is None]
        reasons = []
        if missing:
            reasons.append("Declare rights for every added file (unknown is allowed).")
        if not entries:
            reasons.append("An edited bundle needs at least one file.")
        if entries and not removed and all(e["change"] == "unchanged" for e in entries):
            reasons.append("No change relative to the baseline.")
        result = {
            "baseline": {
                **revision_result(baseline),
                "name": baseline.bundle.name,
                "role": baseline.bundle.role,
            },
            "source": source,
            "marker": marker,
            "root_prefix": prefix,
            "files": entries,
            "removed": removed,
            "excluded": excluded_rows,
            "counts": counts,
            "missing_rights": missing,
            "ready": not reasons,
            "reasons": reasons,
            "review_sha256": hashlib.sha256(canonical_bytes(material)).hexdigest(),
            "execution": "none",
            "validation": "not_performed",
        }
        return result, entries, staged
    except BaseException:
        for item in staged:
            blobstore.discard(item[1])
        raise


def _head(bundle: SourceBundle) -> SourceBundleRevision:
    return bundle.revisions.order_by("-number").first()


def _head_state(ctx: Context, baseline) -> dict:
    head = _head(baseline.bundle)
    authorize_revision(ctx.user, head)
    return {
        "head_revision_id": str(head.id),
        "head_number": head.number,
        "state": bundle_state(baseline.bundle, head.number),
        "baseline_is_head": head.id == baseline.id,
        "next_revision_allowed": head.id == baseline.id
        and baseline.bundle.role == SourceBundle.Role.DERIVATIVE,
    }


# ---------------------------------------------------------------- operations


@operation(
    "source.preview_edit",
    EditInput,
    summary="Review edited native files against an exact baseline without changing state.",
    supports_idempotency=False,
)
def preview_edit(ctx: Context, p: EditInput) -> dict:
    baseline, archive = _closure(ctx, p)
    result, _, staged = review(p, baseline, archive)
    for _, item in staged:
        blobstore.discard(item)
    return {**result, **_head_state(ctx, baseline)}


@operation(
    "source.submit_edit",
    SubmitEdit,
    summary="Submit a reviewed edited bundle as a separate derivative or next derivative "
    "revision; never merges or overwrites.",
    requires_expected_state=True,
    idempotency_scope=_submit_scope,
    authorize_replay=_replay_authority,
)
def submit_edit(ctx: Context, p: SubmitEdit) -> dict:
    baseline, archive = _closure(ctx, p)
    bundle = SourceBundle.objects.select_for_update().get(id=baseline.bundle_id)
    latest = bundle.revisions.aggregate(n=Max("number"))["n"]
    current = bundle_state(bundle, latest)
    if ctx.expected_state != current:
        raise Conflict(
            "The baseline's bundle changed since it was reviewed.",
            details=_head_state(ctx, baseline),
        )
    if p.target == "next_revision" and (
        bundle.role != SourceBundle.Role.DERIVATIVE or latest != baseline.number
    ):
        raise Conflict(
            "Only the current head of a derivative bundle can receive the next revision. "
            "Submit a separate derivative instead; nothing is merged.",
            details=_head_state(ctx, baseline),
        )
    result, entries, staged = review(p, baseline, archive)
    try:
        if result["review_sha256"] != p.reviewed_sha256:
            raise Conflict(
                "The edited change set differs from the reviewed one; review it again.",
                details={"review_sha256": result["review_sha256"]},
            )
        if not result["ready"]:
            raise ValidationFailed(" ".join(result["reasons"]), details=result["counts"])
        kept = {e["sha256"] for e in entries}
        for _, item in staged:
            if item.sha256 in kept:
                blobstore.promote(item)
                SourceBlob.objects.get_or_create(
                    workspace_id=bundle.workspace_id,
                    sha256=item.sha256,
                    defaults={"size": item.size, "media_type": OCTET, "registered_by": ctx.user},
                )
        files = [
            FileRef(
                path=e["path"], sha256=e["sha256"], media_type=e["media_type"], rights=e["rights"]
            )
            for e in entries
        ]
        if p.target == "new_derivative":
            bundle = SourceBundle.objects.create(
                workspace_id=bundle.workspace_id,
                name=p.name,
                role=SourceBundle.Role.DERIVATIVE,
                derived_from=baseline,
                created_by=ctx.user,
            )
        revision = _write_revision(ctx, bundle, files, [str(baseline.id)])
        SourceEditSubmission.objects.create(
            revision=revision,
            baseline=baseline,
            archive_file=archive,
            parser=PARSER if archive else "",
            marker=result["marker"],
            root_prefix=result["root_prefix"],
            review_sha256=result["review_sha256"],
            summary=p.summary,
        )
        return {
            **revision_result(revision),
            "target": p.target,
            "baseline_revision_id": str(baseline.id),
            "review_sha256": result["review_sha256"],
            "counts": result["counts"],
            "source": result["source"],
            "execution": "none",
            "validation": "not_performed",
        }
    finally:
        for _, item in staged:
            blobstore.discard(item)


def submission_provenance(revision: SourceBundleRevision):
    submission = (
        SourceEditSubmission.objects.select_related("archive_file__blob", "baseline__bundle")
        .filter(revision=revision)
        .first()
    )
    if submission is None:
        return None
    archive = submission.archive_file
    return {
        "baseline_revision_id": str(submission.baseline_id),
        "baseline_number": submission.baseline.number,
        "baseline_manifest_sha256": submission.baseline.manifest_sha256,
        "target": "next_revision"
        if submission.baseline.bundle_id == revision.bundle_id
        else "new_derivative",
        "source": {
            "kind": "zip",
            "revision_id": str(archive.revision_id),
            "path": archive.path,
            "sha256": archive.blob.sha256,
            "parser": submission.parser,
        }
        if archive
        else {"kind": "files"},
        "marker": submission.marker,
        "root_prefix": submission.root_prefix,
        "review_sha256": submission.review_sha256,
        "summary": submission.summary,
        "execution": "none",
        "validation": "not_performed",
    }
