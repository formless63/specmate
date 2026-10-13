"""Derived change review; never reattach, invalidate or overwrite historical evidence."""

import hashlib
import json

from django.db.models import Q

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import get_snapshot
from specmate.catalog_matching.queries import current_actor
from specmate.design.operations import canonical_bytes
from specmate.facts.models import FactAssertion
from specmate.facts.queries import (
    assertion_result,
    resolve_target,
    subject_result,
    subject_target,
)
from specmate.firmware_builds.operations import inputs
from specmate.firmware_impact.contracts import CompareImpact
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.queries import get_bundle_revision, get_revision

MAX_ASSERTIONS = 5000


def authorize_evidence(user, rows):
    """Fact inputs and source restrictions remain current, recursively, before diagnostics."""
    pending, visited, subjects, sources = list(rows), set(), set(), set()
    while pending:
        row = pending.pop()
        if row.id in visited:
            continue
        visited.add(row.id)
        if len(visited) > MAX_ASSERTIONS:
            raise ValidationFailed("Impact evidence exceeds the supported closure limit.")
        if row.subject_id not in subjects:
            authorize(user, row.subject.project_id, Perm.PROJECT_READ)
            resolve_target(user, subject_target(row.subject))
            subjects.add(row.subject_id)
        for link in row.source_links.select_related("source_file"):
            if link.source_file.revision_id not in sources:
                get_bundle_revision(user, link.source_file.revision_id)
                sources.add(link.source_file.revision_id)
        pending.extend(
            link.input_assertion
            for link in row.input_links.select_related("input_assertion__subject")
        )


def authorized_inputs(ctx, p):
    user = current_actor(ctx.user)
    authorize(user, p.project_id, Perm.PROJECT_READ)
    # Resolve both complete frozen closures before kind, path or comparison diagnostics.
    revisions, snapshots = [], []
    for ref in (p.baseline, p.candidate):
        revisions.append(get_revision(user, ref.firmware_revision_id))
        snapshots.append(
            get_snapshot(user, ref.assembly_snapshot_id)[0] if ref.assembly_snapshot_id else None
        )
    selected = list(FactAssertion.objects.select_related("subject").filter(id__in=p.assertion_ids))
    authorize_evidence(user, selected)
    for revision in revisions:
        if revision.definition.project_id != p.project_id:
            raise NotFound("Firmware revision unavailable in this project.")
    if any(snapshot and snapshot.definition.project_id != p.project_id for snapshot in snapshots):
        raise NotFound("Assembly snapshot unavailable in this project.")
    if any(row.subject.project_id != p.project_id for row in selected):
        raise NotFound("Historical assertion unavailable in this project.")
    if len(selected) != len(p.assertion_ids):
        raise NotFound("Historical assertion unavailable.")
    baseline_content = json.loads(bytes(revisions[0].snapshot.canonical))["content"]
    target = baseline_content.get("firmware", {}).get("target", {})
    population_id = target.get("population_revision_id")
    revision_ids = [revisions[0].id, *([population_id] if population_id else [])]
    related = Q(subject__kind="revision", subject__revision_id__in=revision_ids)
    related |= Q(
        subject__kind="physical_unit", subject__physical_unit__revision_id__in=revision_ids
    )
    if snapshots[0]:
        related |= Q(
            subject__kind="occurrence",
            subject__snapshot=snapshots[0],
            subject__path=p.baseline.path,
        )
        related |= Q(
            subject__kind="physical_unit", subject__physical_unit__revision__snapshot=snapshots[0]
        )
    # Bound database materialization as well as closure traversal. The extra row
    # detects overflow; oversized scopes return no partial comparison or labels.
    rows = list(
        FactAssertion.objects.select_related("subject", "subject__physical_unit")
        .filter(related | Q(id__in=p.assertion_ids), subject__project_id=p.project_id)
        .order_by("recorded_at", "id")[: MAX_ASSERTIONS + 1]
    )
    authorize_evidence(user, rows)
    if len(rows) > MAX_ASSERTIONS:
        raise ValidationFailed("Impact evidence exceeds the supported assertion limit.")
    # Only now may exact occurrence assignment/target diagnostics be exposed.
    baseline = inputs(user, p.baseline)
    candidate = inputs(user, p.candidate)
    for item in (baseline, candidate):
        # The shared frozen-reference resolver also serves compiler requests.
        # This inert read advertises no native pack execution capability.
        item[2].pop("adapter", None)
    return baseline, candidate, rows


def compare_values(key, before, after, *, unknown=False, reason=None):
    status = "changed" if before != after else "unknown" if unknown else "unchanged"
    return {
        "key": key,
        "status": status,
        "baseline": before,
        "candidate": after,
        "reason": reason
        or {
            "changed": "The exact recorded assumption changed; review dependent evidence.",
            "unchanged": "The recorded inputs match; this does not establish compatibility.",
            "unknown": "Matching missing or unresolved inputs do not establish agreement.",
        }[status],
    }


def findings(before, after):
    b, a = before[2], after[2]
    be, ae = before[1]["evaluation"], after[1]["evaluation"]
    rows = [
        compare_values("firmware_revision", b["firmware_revision_id"], a["firmware_revision_id"]),
        compare_values(
            "occurrence",
            b["occurrence"],
            a["occurrence"],
            unknown=b["occurrence"] is None or a["occurrence"] is None,
        ),
        compare_values("hardware_target", b["target"], a["target"]),
        compare_values(
            "native_board",
            {key: value for key, value in be["target"].items() if key != "pads"},
            {key: value for key, value in ae["target"].items() if key != "pads"},
        ),
        compare_values("sources", b["sources"], a["sources"]),
        compare_values(
            "toolchain",
            b["toolchain"],
            a["toolchain"],
            unknown=any(v is None for v in b["toolchain"].values())
            or any(v is None for v in a["toolchain"].values()),
        ),
    ]
    for field, identity in (("configuration", "key"), ("pins", "signal")):
        left = {r[identity]: r for r in b[field]}
        right = {r[identity]: r for r in a[field]}
        for key in sorted(left.keys() | right.keys()):
            old, new = left.get(key), right.get(key)
            unknown = (
                old is None
                or new is None
                or (
                    field == "configuration"
                    and (old["status"] != "known" or new["status"] != "known")
                )
                or (field == "pins" and (old.get("pad_id") is None or new.get("pad_id") is None))
            )
            rows.append(compare_values(f"{field}.{key}", old, new, unknown=unknown))
            if field == "pins":
                anchors = []
                for entry, evaluation in ((old, be), (new, ae)):
                    native = evaluation["target"]
                    pad = next(
                        (
                            pad
                            for pad in native["pads"]
                            if entry and pad["id"] == entry.get("pad_id")
                        ),
                        None,
                    )
                    anchors.append(
                        {
                            "interpretation_id": native["interpretation_id"],
                            "interpretation_sha256": native["interpretation_sha256"],
                            "population_revision_id": native["population_revision_id"],
                            "option_id": native["option_id"],
                            "native_pad": pad,
                        }
                    )
                rows.append(
                    compare_values(
                        f"pin_hardware.{key}",
                        *anchors,
                        unknown=any(
                            anchor["native_pad"] is None or not anchor["native_pad"]["net"]
                            for anchor in anchors
                        ),
                    )
                )
    for key, reason in (
        ("mcu_pin_capability", "MCU electrical/peripheral capability is not evaluated."),
        ("toolchain_support", "Matching toolchain declarations do not verify target support."),
        ("device_operation", "Compiler receipts are build evidence, not device observations."),
    ):
        rows.append(compare_values(key, None, None, unknown=True, reason=reason))
    return rows


def applicability(row, p, baseline, changed):
    subject = row.subject
    target = baseline[2]["target"]["population_revision_id"]
    exact = (
        subject.kind == "revision"
        and str(subject.revision_id) in {str(p.baseline.firmware_revision_id), target}
    ) or (
        subject.kind == "occurrence"
        and subject.snapshot_id == p.baseline.assembly_snapshot_id
        and subject.path == p.baseline.path
    )
    if subject.kind == "physical_unit":
        status = "review_required"
        reason = (
            "This observation belongs to the actual physical unit. Its installed firmware "
            "and relation to the candidate are not established; never transfer the result."
        )
    elif not exact:
        status = "unknown"
        reason = "The selected assertion is not attached to the exact baseline subject."
    elif changed:
        status = "review_required"
        reason = "Changed exact assumptions require review; the historical result stays attached."
    else:
        status = "retained_on_original_subject"
        reason = (
            "The exact recorded inputs match. Observation conditions and physical "
            "applicability still require review; no candidate result is created."
        )
    return {
        "assertion": assertion_result(row),
        "subject": subject_result(subject),
        "applicability": status,
        "reason": reason,
        "review_keys": changed,
        "candidate_result": None,
        "historical_result_preserved": True,
    }


@operation(
    "firmware_impact.compare",
    CompareImpact,
    summary="Review exact firmware/hardware changes and historical observation applicability.",
    supports_idempotency=False,
)
def compare(ctx: Context, p: CompareImpact):
    baseline, candidate, assertions = authorized_inputs(ctx, p)
    rows = findings(baseline, candidate)
    changed = [row["key"] for row in rows if row["status"] == "changed"]
    result = {
        "project_id": str(p.project_id),
        "baseline": {
            "reference": p.baseline.model_dump(mode="json"),
            "inputs": baseline[2],
            "evaluation": baseline[1]["evaluation"],
        },
        "candidate": {
            "reference": p.candidate.model_dump(mode="json"),
            "inputs": candidate[2],
            "evaluation": candidate[1]["evaluation"],
        },
        "findings": rows,
        "observations": [
            applicability(row, p, baseline, changed)
            for row in assertions[p.observation_offset : p.observation_offset + 100]
        ],
        "observations_total": len(assertions),
        "observation_offset": p.observation_offset,
        "observations_truncated": len(assertions) > 100,
        "observations_has_more": len(assertions) > p.observation_offset + 100,
        "observation_scope": "exact_baseline_subjects_and_deliberately_selected_assertions",
        "review_required": bool(changed) or any(row["status"] == "unknown" for row in rows),
        "hardware_compatibility": "not_evaluated",
        "compiler_receipts": "not_assessed",
        "flashing": "not_performed",
        "device_operation": "not_observed",
        "physical_qualification": False,
        "historical_results_modified": False,
    }
    return {**result, "comparison_sha256": hashlib.sha256(canonical_bytes(result)).hexdigest()}
