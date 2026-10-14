"""Reproducibility levels derived from independent repeated executions (BLD-006).

Levels, weakest first:

- ``provenance``: exact inputs, recipe and outputs are recorded. A single successful
  execution never claims more than this, whatever its exit code.
- ``rerun_recorded``: another accepted attempt over the identical input key exists, but
  its outputs neither match byte for byte nor under a declared comparator.
- ``semantic_equality``: repeated outputs differ in bytes but are equal under a declared
  comparator (for example, a canonical form of a JSON report).
- ``byte_reproducible``: independent repeated outputs are byte-identical.

Comparisons are recorded once, append-only, when an attempt's success is accepted; the
level is derived from those records, never stored as a mutable label.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable
from datetime import datetime

from django.db import connection
from django.db.models import Q

from specmate.builds.models import BuildAttempt, BuildStage, ReproducibilityComparison
from specmate.sources import blobstore

LEVELS = ("provenance", "rerun_recorded", "semantic_equality", "byte_reproducible")
MAX_BASELINES = 20


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def input_key(staged_inputs: list[dict] | None, recipe: dict, configuration: dict | None):
    """Digest of exactly what an execution consumed; None when inputs were not retained."""
    if staged_inputs is None:
        return None
    return hashlib.sha256(
        _canonical({"inputs": staged_inputs, "recipe": recipe, "configuration": configuration})
    ).hexdigest()


def _json_canonical(left: bytes, right: bytes) -> bool:
    return _canonical(json.loads(left)) == _canonical(json.loads(right))


def _is_json(media_type: str) -> bool:
    base = media_type.split(";", 1)[0].strip().lower()
    return base == "application/json" or base.endswith("+json")


# Declared comparators: (identifier, applies to media type, equality). The identifier is
# recorded with every comparison so a later comparator version never rewrites history.
COMPARATORS: tuple[tuple[str, Callable[[str], bool], Callable[[bytes, bytes], bool]], ...] = (
    ("json-canonical/1", _is_json, _json_canonical),
)


def _read(sha256: str, size: int) -> bytes:
    with blobstore.open_blob(sha256) as stream:
        return stream.read(size + 1)


def _compare(baseline, candidate) -> tuple[bool, str, str]:
    if baseline.sha256 == candidate.sha256 and baseline.size == candidate.size:
        return True, "", ReproducibilityComparison.Result.NOT_NEEDED
    for name, applies, equal in COMPARATORS:
        if applies(candidate.media_type) and applies(baseline.media_type):
            try:
                same = equal(
                    _read(baseline.sha256, baseline.size), _read(candidate.sha256, candidate.size)
                )
            except (ValueError, UnicodeDecodeError, OSError):
                return False, name, ReproducibilityComparison.Result.UNREADABLE
            result = ReproducibilityComparison.Result
            return False, name, result.EQUAL if same else result.DIFFERENT
    return False, "", ReproducibilityComparison.Result.NONE_DECLARED


def record_comparisons(stage: BuildStage) -> int:
    """Compare a just-accepted attempt with earlier accepted attempts over the same key."""
    build = stage.build
    if build.input_key is None:
        return 0
    # Serialize acceptance per input key so two concurrent successes still meet each other.
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [build.input_key])
    baselines = (
        BuildAttempt.objects.filter(
            workspace_id=build.workspace_id, input_key=build.input_key, stage__state="succeeded"
        )
        .exclude(id=build.id)
        .select_related("stage")
        .order_by("-created_at", "-id")[:MAX_BASELINES]
    )
    outputs = {o.path: o for o in stage.outputs.all()}
    created = 0
    for baseline in baselines:
        for prior in baseline.stage.outputs.order_by("path"):
            current = outputs.get(prior.path)
            if current is None:
                continue
            identical, comparator, result = _compare(prior, current)
            ReproducibilityComparison.objects.create(
                workspace_id=build.workspace_id,
                input_key=build.input_key,
                baseline=baseline,
                candidate=build,
                path=prior.path,
                media_type=current.media_type,
                baseline_sha256=prior.sha256,
                candidate_sha256=current.sha256,
                byte_identical=identical,
                comparator=comparator,
                result=result,
            )
            created += 1
    return created


def _level(row: ReproducibilityComparison) -> str:
    if row.byte_identical:
        return "byte_reproducible"
    if row.result == ReproducibilityComparison.Result.EQUAL:
        return "semantic_equality"
    return "rerun_recorded"


def _rank(level: str) -> int:
    return LEVELS.index(level)


def comparisons_for(build_ids: Iterable, as_of: datetime | None = None):
    rows = ReproducibilityComparison.objects.filter(
        Q(baseline_id__in=build_ids) | Q(candidate_id__in=build_ids)
    )
    if as_of is not None:
        rows = rows.filter(created_at__lte=as_of)
    return list(rows.order_by("created_at", "id"))


def derive(build: BuildAttempt, stage: BuildStage, rows=None, as_of=None) -> dict | None:
    """Per-output and overall level of an accepted attempt; None if nothing was accepted.

    ``as_of`` limits the evidence to comparisons recorded by then, so a retained package
    manifest can be rebuilt exactly even after later reruns strengthen the level.
    """
    if stage.state != "succeeded":
        return None
    if rows is None:
        rows = comparisons_for([build.id], as_of)
    paths = sorted(stage.outputs.values_list("path", flat=True))
    per_path = {}
    for path in paths:
        mine = [r for r in rows if r.path == path and build.id in (r.baseline_id, r.candidate_id)]
        level = max((_level(r) for r in mine), key=_rank, default="provenance")
        semantic = sorted({r.comparator for r in mine if _level(r) == "semantic_equality"})
        per_path[path] = {
            "level": level,
            "attempts_compared": len(
                {r.candidate_id if r.baseline_id == build.id else r.baseline_id for r in mine}
            ),
            "comparators": semantic,
        }
    overall = min((v["level"] for v in per_path.values()), key=_rank, default="provenance")
    return {"level": overall, "outputs": per_path}


def comparison_rows(build: BuildAttempt, rows) -> list[dict]:
    return [
        {
            "path": r.path,
            "other_build_id": str(r.candidate_id if r.baseline_id == build.id else r.baseline_id),
            "byte_identical": r.byte_identical,
            "comparator": r.comparator or None,
            "result": r.result,
            "level": _level(r),
            "this_sha256": r.baseline_sha256 if r.baseline_id == build.id else r.candidate_sha256,
            "other_sha256": r.candidate_sha256 if r.baseline_id == build.id else r.baseline_sha256,
            "recorded_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


def levels_for(builds: list[BuildAttempt]) -> dict:
    """Overall level per accepted build in one query, for lists."""
    succeeded = [b for b in builds if b.stage.state == "succeeded"]
    rows = comparisons_for([b.id for b in succeeded])
    compared = {r.baseline_id for r in rows} | {r.candidate_id for r in rows}
    result = {}
    for build in succeeded:
        if build.id not in compared:
            result[build.id] = "provenance"
            continue
        derived = derive(build, build.stage, rows)
        result[build.id] = derived["level"] if derived else None
    return result
