"""Reviewed release closure (EVD-004): one deterministic review of everything a release freezes.

The closure reuses the existing shared reads instead of reimplementing them:

- the coherent export package (DOC-001/003) resolves the exact root closure, checks every
  retained output against it and produces the manifest and archive bytes;
- resolved configurations are read through their own authority and cited against it;
- source pins and rights subjects use the selected-package rules (DOC-002/004 subject
  format ``design:<revision>`` and ``source:<revision>:<path>``);
- evidence applicability (EVD-003) classifies observations against each pinned revision.

Required blockers (incoherent outputs, invalid or conflicting configurations) prevent a
release. Everything else that is not established (unknown quantities, missing outputs,
stale or unverified evidence, uncleared rights, unknown or restricted declared catalog
rights from the export package's rights section) is listed as an unresolved item that a
release may carry only with an explicit acknowledgement. Nothing here writes state.
"""

from collections import Counter
from types import SimpleNamespace

from django.db.models import Max

from specmate.catalog_matching.queries import current_actor
from specmate.configurations.operations import constraint_summary, resolved_result
from specmate.design.models import Revision
from specmate.design.operations import canonical_bytes
from specmate.evidence.applicability import applicability_items, definitions_with_evidence
from specmate.export_packages.contracts import ExportRequest
from specmate.export_packages.queries import build_package, digest
from specmate.operations import ValidationFailed
from specmate.selected_packages.queries import collect_sources, review_value

FORMAT = "specmate.release-review"
SCHEMA_VERSION = "0.1"
# Evidence applicability is read per pinned revision; larger closures say what was skipped.
EVIDENCE_REVISION_LIMIT = 200
UNRESOLVED_EVIDENCE = {"stale_earlier_revision", "definition_scope_unverified"}
SEMANTICS = {
    "meaning": "Frozen reviewed design closure with acknowledged unresolved items.",
    "manufacturing_approval": False,
    "physical_qualification": "not_evaluated",
    "distribution": "not_authorized",
}


def export_request(p):
    return ExportRequest.model_validate(
        p.model_dump(mode="json", include=set(ExportRequest.model_fields))
    )


def item(category, key, reason, **details):
    return {"id": f"{category}:{key}", "category": category, "reason": reason, **details}


def pinned_revisions(manifest):
    ids = [row["revision_id"] for row in manifest["pins"]]
    rows = Revision.objects.select_related("definition", "snapshot").in_bulk(ids)
    return {str(rid): revision for rid, revision in rows.items()}


def revision_section(manifest, revisions):
    root_id = manifest["scope"]["root"]["revision_id"]
    latest = dict(
        Revision.objects.filter(definition_id__in={r.definition_id for r in revisions.values()})
        .order_by()
        .values("definition_id")
        .annotate(n=Max("number"))
        .values_list("definition_id", "n")
    )
    out = []
    for pin in manifest["pins"]:
        revision = revisions[pin["revision_id"]]
        newest = latest.get(revision.definition_id, revision.number)
        if pin["revision_id"] == root_id:
            role = "root"
        elif pin["per_root_occurrences"]:
            role = "occurrence"
        else:
            role = "dependency"
        out.append(
            {
                **{k: pin[k] for k in ("revision_id", "definition_id", "kind", "name", "number")},
                "snapshot_sha256": pin["sha256"],
                "role": role,
                "per_root_occurrences": pin["per_root_occurrences"],
                "scope_quantity": pin["scope_quantity"],
                # A later revision is reported, never adopted: the pin stays exact.
                "later_revision_number": newest if newest > revision.number else None,
            }
        )
    return out


def configuration_section(ctx, p, revisions, unresolved, blockers):
    definitions = {}
    for revision in revisions.values():
        definitions.setdefault(str(revision.definition_id), set()).add(str(revision.id))
    out = []
    for cid in p.resolved_configuration_ids:
        row, result = resolved_result(ctx, cid)
        resolution = result["resolution"]
        constraints = constraint_summary(resolution)
        target = (resolution.get("target") or {}).get("revision_id")
        findings = []
        if target is None:
            findings.append("target_unknown")
        elif target not in revisions:
            blockers.append(
                item(
                    "configuration",
                    f"{cid}:target_not_in_release",
                    "The configuration targets a revision outside the release closure.",
                    resolved_configuration_id=str(cid),
                    target_revision_id=target,
                )
            )
        for dep in row.snapshot.dependencies.select_related("revision"):
            pinned = definitions.get(str(dep.revision.definition_id))
            if pinned and str(dep.revision_id) not in pinned:
                blockers.append(
                    item(
                        "configuration",
                        f"{cid}:cites_different_revision:{dep.revision_id}",
                        "The configuration cites another revision of a definition the release "
                        "pins.",
                        resolved_configuration_id=str(cid),
                        revision_id=str(dep.revision_id),
                        release_revision_ids=sorted(pinned),
                    )
                )
        status = resolution.get("status", row.status)
        if status == "invalid" or constraints["outcome"] == "invalid":
            blockers.append(
                item(
                    "configuration",
                    f"{cid}:invalid",
                    "The configuration has invalid selections or violates declared constraints.",
                    resolved_configuration_id=str(cid),
                    invalid=constraints["invalid"],
                )
            )
        if status == "incomplete":
            choices = [
                d["option_key"] for d in resolution["decisions"] if d["status"] == "unresolved"
            ]
            unresolved.append(
                item(
                    "configuration",
                    f"{cid}:incomplete",
                    "Required configuration choices are unresolved.",
                    resolved_configuration_id=str(cid),
                    option_keys=choices,
                )
            )
        counts = constraints["counts"] or {}
        if constraints["outcome"] == "unknown" or counts.get("not_evaluated"):
            unresolved.append(
                item(
                    "configuration",
                    f"{cid}:constraints_not_established",
                    "Declared configuration constraints are unknown or not evaluated.",
                    resolved_configuration_id=str(cid),
                    unknown=constraints["unknown"],
                    outcome=constraints["outcome"],
                )
            )
        if target is None:
            unresolved.append(
                item(
                    "configuration",
                    f"{cid}:target_unknown",
                    "The configuration's target is not declared; its fit to the release is "
                    "unknown.",
                    resolved_configuration_id=str(cid),
                )
            )
        out.append(
            {
                "resolved_configuration_id": str(cid),
                "snapshot_id": result["snapshot_id"],
                "snapshot_sha256": result["snapshot_sha256"],
                "resolution_sha256": result["resolution_sha256"],
                "option_set_revision_id": result["option_set_revision_id"],
                "target_revision_id": target,
                "status": status,
                "constraint_outcome": constraints["outcome"],
                "findings": findings,
            }
        )
    return out


def source_section(user, revisions, p, unresolved):
    """Exact source file pins and one rights subject per design revision and source file."""
    files, opaque = collect_sources(user, {r.id: r for r in revisions.values()})
    reviews = {review.subject: review for review in p.rights_reviews}
    sources = [
        {
            "source_revision_id": rid,
            "path": path,
            "sha256": file.blob.sha256,
            "bytes": file.blob.size,
            "manifest_sha256": file.revision.manifest_sha256,
            "declared_rights": file.rights,
        }
        for (rid, path), file in sorted(files.items())
    ]
    for rid in sorted(opaque):
        unresolved.append(
            item(
                "dependencies",
                f"source_bundle:{rid}",
                "A pinned source bundle revision is referenced without an exact file; its "
                "required content and rights are not established.",
                source_revision_id=rid,
            )
        )
    subjects = [
        {"subject": f"design:{rid}", "kind": "design", "revision_id": rid, "declared_rights": None}
        for rid in sorted(revisions)
    ] + [
        {
            "subject": f"source:{row['source_revision_id']}:{row['path']}",
            "kind": "source_file",
            "revision_id": row["source_revision_id"],
            "path": row["path"],
            "declared_rights": row["declared_rights"],
        }
        for row in sources
    ]
    known = {row["subject"] for row in subjects}
    if set(reviews) - known:
        raise ValidationFailed("Rights review must identify an exact release subject.")
    for row in subjects:
        row["review"] = review_value(reviews, row["subject"])
        if row["review"]["decision"] != "permitted":
            unresolved.append(
                item(
                    "rights",
                    row["subject"],
                    f"Rights for this exact subject are not cleared ({row['review']['decision']}).",
                    subject=row["subject"],
                    decision=row["review"]["decision"],
                )
            )
    cleared = sum(1 for row in subjects if row["review"]["decision"] == "permitted")
    rights = {"subjects": subjects, "cleared": cleared, "uncleared": len(subjects) - cleared}
    return {"sources": sources, "opaque_source_revision_ids": sorted(opaque)}, rights


def catalog_rights(manifest, unresolved):
    """The export package's declared catalog rights (representations and source identifiers).

    Read as recorded by the coherent export package; anything not cleared (unknown or
    restricted) is an unresolved item the release must acknowledge, never a silent pass.
    """
    review = manifest["rights"]
    for row in review["items"]:
        if row["rights_status"] == "cleared":
            continue
        unresolved.append(
            item(
                "rights",
                row["subject"],
                f"Declared catalog rights for {row['definition_name']} ({row['record']}: "
                f"{row['label']}) are {row['rights_status']}.",
                subject=row["subject"],
                revision_id=row["revision_id"],
                rights_status=row["rights_status"],
            )
        )
    return {
        "items": review["items"],
        "counts": review["counts"],
        "undeclared_revision_ids": review["undeclared_revision_ids"],
        "unresolved": sum(1 for row in review["items"] if row["rights_status"] != "cleared"),
    }


def evidence_section(user, workspace_id, revisions, unresolved):
    ordered = sorted(revisions.values(), key=lambda r: str(r.id))
    evaluated, skipped = ordered[:EVIDENCE_REVISION_LIMIT], ordered[EVIDENCE_REVISION_LIMIT:]
    items, statuses = [], Counter()
    # Revisions of a definition without any evidence row classify nothing; skip their reads.
    candidates = definitions_with_evidence(workspace_id, {r.definition_id for r in evaluated})
    for revision in evaluated:
        if revision.definition_id not in candidates:
            continue
        scan = SimpleNamespace(limit_reached=False)
        rows = applicability_items(user, SimpleNamespace(workspace_id=workspace_id), revision, scan)
        for _, evidence, applicability in rows:
            status = applicability["status"]
            statuses[status] += 1
            row = {
                "revision_id": str(revision.id),
                "evidence_id": evidence["evidence_id"],
                "kind": evidence["kind"],
                "status": status,
            }
            items.append(row)
            if status in UNRESOLVED_EVIDENCE:
                unresolved.append(
                    item(
                        "evidence",
                        f"{status}:{revision.id}:{evidence['evidence_id']}",
                        applicability["reason"],
                        revision_id=str(revision.id),
                        evidence_id=evidence["evidence_id"],
                        status=status,
                    )
                )
        if scan.limit_reached:
            unresolved.append(
                item(
                    "evidence",
                    f"scan_limit:{revision.id}",
                    "Evidence for this revision exceeded the scan limit; later items were not "
                    "reviewed.",
                    revision_id=str(revision.id),
                )
            )
    if skipped:
        unresolved.append(
            item(
                "evidence",
                "not_evaluated",
                f"Evidence applicability was not reviewed for {len(skipped)} pinned revisions "
                "beyond the review limit.",
                revision_ids=[str(r.id) for r in skipped],
            )
        )
    items.sort(key=lambda row: (row["revision_id"], row["evidence_id"]))
    return {
        "items": items,
        "counts": dict(sorted(statuses.items())),
        "evaluated_revisions": len(evaluated),
        "not_evaluated_revisions": len(skipped),
        "qualifies_release": False,
    }


def package_items(manifest, unresolved, blockers):
    if manifest["scope"]["quantity"] is None:
        unresolved.append(
            item(
                "quantity",
                "root",
                "The root quantity in scope is unknown; every derived quantity stays unknown.",
            )
        )
    for output in manifest["outputs"]:
        for index, finding in enumerate(output["findings"]):
            entry = item(
                "artifacts",
                f"{output['id']}:{index}:{finding['reason']}",
                finding["reason"],
                output=output["id"],
                finding=finding,
            )
            (blockers if finding["status"] == "incoherent" else unresolved).append(entry)
    for index, row in enumerate(manifest["unresolved"]):
        unresolved.append(
            item(
                "artifacts",
                f"package:{index}:{row.get('reason', 'unresolved')}",
                str(row.get("reason", "unresolved")),
                detail=row,
            )
        )


def review_release(ctx, p, as_of=None):
    """(review, export files, manifest sha256) for one release request; writes nothing.

    ``as_of`` bounds build reproducibility evidence (see ``build_package``).
    """
    user = current_actor(ctx.user)
    manifest, files, manifest_sha256 = build_package(ctx, export_request(p), as_of=as_of)
    revisions = pinned_revisions(manifest)
    root = revisions[manifest["scope"]["root"]["revision_id"]]
    workspace_id = root.definition.workspace_id
    unresolved, blockers = [], []
    package_items(manifest, unresolved, blockers)
    configurations = configuration_section(ctx, p, revisions, unresolved, blockers)
    dependencies, rights = source_section(user, revisions, p, unresolved)
    rights["catalog"] = catalog_rights(manifest, unresolved)
    evidence = evidence_section(user, workspace_id, revisions, unresolved)
    pins = revision_section(manifest, revisions)
    review = {
        "format": FORMAT,
        "schema_version": SCHEMA_VERSION,
        "workspace_id": str(workspace_id),
        "request": p.model_dump(
            mode="json", include=set(ExportRequest.model_fields) | {"resolved_configuration_ids"}
        ),
        "root": manifest["scope"]["root"],
        "quantity": {
            "status": manifest["scope"]["quantity_status"],
            "amount": manifest["scope"]["quantity"],
        },
        "revisions": [row for row in pins if row["role"] != "dependency"],
        "configurations": configurations,
        "dependencies": {
            "revisions": [row for row in pins if row["role"] == "dependency"],
            **dependencies,
        },
        "artifacts": {
            "package_format": manifest["format"],
            "package_manifest_sha256": manifest_sha256,
            "coherence": manifest["coherence"],
            "completeness": manifest["completeness"],
            "sections": manifest["sections"],
            "outputs": manifest["outputs"],
            "files": manifest["files"],
            "unsupported": manifest["unsupported"],
        },
        "rights": rights,
        "evidence": evidence,
        "unresolved": unresolved,
        "blockers": blockers,
        "status": "blocked" if blockers else "unresolved" if unresolved else "clear",
        "semantics": SEMANTICS,
    }
    return review, files, manifest_sha256


def review_digest(review):
    return digest(canonical_bytes(review))
