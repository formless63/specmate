"""Selected bytes are distinct from the full current authority needed to disclose them."""

import hashlib
import html
import io
import json
import zipfile
from uuid import UUID

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import OccurrenceRef
from specmate.assemblies.queries import get_snapshot, refs
from specmate.cable_test_intent.queries import terminals
from specmate.cables.queries import inspect_revision as inspect_cable
from specmate.catalog.models import Representation
from specmate.catalog_matching.queries import current_actor
from specmate.design.operations import canonical_bytes
from specmate.operations import Conflict, NotFound, Unsupported, ValidationFailed
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources import blobstore
from specmate.sources.authority import authorize_revision
from specmate.sources.models import SourceArchiveExpansion, SourceEditSubmission

MAX_BYTES = 16 * 1024 * 1024
MAX_FILES = 4000
MAX_REVISIONS = 2000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inside(path, selection):
    return tuple(path[: len(selection)]) == selection


def source_pins(value, *, kind=None):
    """Recognize exact existing file-pin shapes, never attach a whole source bundle.

    Unknown native/extension references remain unresolved, rather than claiming a
    reconstruction merely because their containing canonical record is preserved.
    """
    if kind == "firmware":
        from specmate.pcb.firmware import parse_content

        firmware = parse_content(value, kind)
        if firmware is not None:
            # The shared revision read has already checked each manifest, file hash,
            # rights declaration and full source ancestry. Only these typed file
            # pins belong to the selected package, never the rest of their bundle.
            for pin in firmware.sources:
                for file in pin.files:
                    yield str(pin.source_revision_id), file.path, None
            return
    if isinstance(value, dict):
        rid = value.get("source_bundle_revision_id")
        path = value.get("source_path")
        if not rid:
            rid = value.get("bundle_revision_id") or value.get("source_revision_id")
            path = value.get("path")
        if rid:
            yield str(rid), path, None
        if value.get("representation_id"):
            yield None, None, str(value["representation_id"])
        for child in value.values():
            yield from source_pins(child)
    elif isinstance(value, list):
        for child in value:
            yield from source_pins(child)


def selection_context(user, p):
    user = current_actor(user)
    # Full root closure and source ancestry before selection diagnostics.
    root = get_revision(user, p.root_revision_id)
    selection = tuple(p.occurrence_path)
    if not selection:
        selected = root
        closure = None
        if root.definition.kind == "assembly":
            _, closure = get_snapshot(user, root.snapshot_id)
    else:
        _, closure = get_snapshot(user, root.snapshot_id)
        node = closure.nodes.get(selection)
        if node is None:
            raise NotFound("Selected occurrence unavailable.")
        selected = node.revision
    return user, root, selected, closure, selection


def captured_closure(user, root, selected, closure, selection):
    # Assembly capture intentionally retains its entire frozen dependency closure.
    # Only selected revision pins are followed; preloaded root siblings are never copied.
    selected_ids = {selected.id}
    external_ids = set()
    if closure:
        selected_ids |= {
            node.revision.id for path, node in closure.nodes.items() if inside(path, selection)
        }
        external_ids = {
            node.revision.id for path, node in closure.nodes.items() if not inside(path, selection)
        } - selected_ids
        if selection:
            external_ids.add(root.id)
            external_ids |= {
                node.revision.id
                for path, node in closure.nodes.items()
                if len(path) < len(selection) and inside(selection, path)
            } - selected_ids
    ancestor_definitions = {root.definition_id} if selection else set()
    if closure and selection:
        ancestor_definitions |= {
            node.revision.definition_id
            for path, node in closure.nodes.items()
            if len(path) < len(selection) and inside(selection, path)
        }
    pending = [selected.id]
    # Contextual firmware is independently assigned to repeated selected occurrences.
    if closure:
        for path, node in closure.nodes.items():
            if inside(path, selection):
                assignments = closure.assignments.get(path, node.occurrence.assignments)
                if assignments.firmware_revision_id:
                    pending.append(assignments.firmware_revision_id)
    captured = {}
    excluded = set()
    while pending:
        rid = pending.pop()
        if rid in captured or rid in excluded:
            continue
        if rid in external_ids:
            excluded.add(rid)
            continue
        revision = get_revision(user, rid)
        if len(captured) >= MAX_REVISIONS:
            raise ValidationFailed("Selected package dependency limit exceeded.")
        if revision.definition_id in ancestor_definitions and revision.id not in selected_ids:
            excluded.add(rid)
            continue
        captured[rid] = revision
        pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
    return captured, excluded


def occurrence_rows(selected, closure, selection):
    rows = [
        {
            "path": [],
            "revision_id": str(selected.id),
            "sha256": selected.snapshot.sha256,
            "placement": {"status": "unknown", "frame": "selected_boundary", "unit": "mm"},
            "assignments": {"firmware_revision_id": None},
        }
    ]
    if not closure:
        return rows
    for path, node in closure.nodes.items():
        if not inside(path, selection):
            continue
        local_path = list(path[len(selection) :])
        row = {
            "path": local_path,
            "revision_id": str(node.revision.id),
            "sha256": node.revision.snapshot.sha256,
            # A selected root is rebased; its containing parent's placement is provenance only.
            "placement": node.occurrence.placement.model_dump(mode="json")
            if local_path
            else {"status": "unknown", "frame": "selected_boundary", "unit": "mm"},
            "assignments": closure.assignments.get(path, node.occurrence.assignments).model_dump(
                mode="json"
            ),
        }
        if local_path:
            row["display_ref"] = node.occurrence.display_ref
            rows.append(row)
        else:
            rows[0] = row
    return rows


def projected_relationships(closure, selection, captured):
    internal, boundary = [], []
    if closure is None:
        return internal, boundary
    for prefix, relationship in closure.relationships:
        references = refs(relationship)
        selected_refs = [
            ref
            for ref in references
            if isinstance(ref, OccurrenceRef) and inside((*prefix, *ref.path), selection)
        ]
        if not selected_refs:
            continue
        all_inside = all(
            inside((*prefix, *ref.path), selection)
            if isinstance(ref, OccurrenceRef)
            else ref.revision_id in captured
            for ref in references
        )
        if all_inside:
            # Context prefix alone must never leak an ancestor name/address.
            data = relationship.model_dump(mode="json")
            data["context_path"] = list(prefix[len(selection) :])
            if not inside(prefix, selection):
                data["local_id"] = f"context-relationship-{len(internal) + 1}"
            for field, value in relationship.__dict__.items():
                if isinstance(value, OccurrenceRef):
                    data[field]["path"] = list((*prefix, *value.path)[len(selection) :])
            internal.append(data)
        else:
            # The ancestor-owned relationship ID and external ref are also private data.
            boundary.append(
                {
                    "kind": relationship.kind,
                    "selected_terminals": [
                        {
                            "path": list((*prefix, *ref.path)[len(selection) :]),
                            "feature_id": ref.feature_id,
                        }
                        for ref in selected_refs
                    ],
                    "external": "not_included",
                    "external_contract": "unknown",
                    "compatibility": "not_evaluated",
                    "physical_connectivity": "not_evaluated",
                }
            )
    return internal, boundary


def boundary_interfaces(user, occurrences, captured):
    interfaces = []
    for row in occurrences:
        revision = captured[UUID(row["revision_id"])]
        content = json.loads(bytes(revision.snapshot.canonical))["content"]
        common = {
            "path": row["path"],
            "revision_id": row["revision_id"],
            "sha256": row["sha256"],
            "compatibility": "not_evaluated",
            "physical_connectivity": "not_evaluated",
        }
        if revision.definition.kind == "cable" and "cable" in content:
            cable = inspect_cable(user, revision.id)
            interfaces.append(
                {
                    **common,
                    "kind": "cable_endpoints",
                    "endpoints": cable["endpoints"],
                    "terminals": terminals(cable),
                    "boundary_exposure": "declared_endpoints_not_inferred_free_ports",
                }
            )
        elif "interface" in content:
            interfaces.append(
                {
                    **common,
                    "kind": content["interface"]["kind"],
                    "declaration": content["interface"],
                    "boundary_exposure": "declared_not_inferred",
                }
            )
        elif revision.definition.kind in {
            "wire_stock",
            "workshop_profile",
            "end_preparation_profile",
        }:
            interfaces.append(
                {
                    **common,
                    "kind": revision.definition.kind,
                    "boundary_exposure": "definition_data_no_occurrence_interface",
                    "declaration": content,
                }
            )
        elif revision.definition.kind != "assembly":
            interfaces.append(
                {
                    **common,
                    "kind": revision.definition.kind,
                    "boundary_exposure": "unknown",
                    "unsupported": "No portable boundary interpreter for this kind.",
                }
            )
    return interfaces


def collect_sources(user, captured):
    files, opaque = {}, set()
    pins = []
    for revision in captured.values():
        body = json.loads(bytes(revision.snapshot.canonical))
        pins.extend(source_pins(body["content"], kind=revision.definition.kind))
    # Resolve all source revisions/ancestry before any missing-path diagnostic.
    source_revisions = {}
    for rid, path, representation_id in pins:
        if representation_id:
            representation = (
                Representation.objects.select_related(
                    "source_file__revision__bundle", "source_file__blob", "revision"
                )
                .filter(id=representation_id)
                .first()
            )
            if representation is None:
                raise NotFound("Package source unavailable.")
            get_revision(user, representation.revision_id)
            file = representation.source_file
            rid, path = str(file.revision_id), file.path
        if rid not in source_revisions:
            source = get_bundle_revision(user, rid)
            authorize_revision(user, source)
            source_revisions[rid] = source
        if path:
            files[(rid, path)] = None
        else:
            opaque.add(rid)
    for rid, path in files:
        file = source_revisions[rid].files.select_related("blob").filter(path=path).first()
        if file is None:
            raise NotFound("Package source unavailable.")
        files[(rid, path)] = file
    return files, opaque


def source_ancestry(user, revision):
    """Exact provenance identities/hashes only, never ancestor bundle contents or names."""
    pending, seen, rows = [revision], set(), []
    while pending:
        current = pending.pop()
        if current.id in seen:
            continue
        if len(seen) >= MAX_REVISIONS:
            raise ValidationFailed("Selected source ancestry limit exceeded.")
        seen.add(current.id)
        authorize_revision(user, current)
        rows.append(
            {"source_revision_id": str(current.id), "manifest_sha256": current.manifest_sha256}
        )
        if current.bundle.derived_from_id:
            pending.append(get_bundle_revision(user, current.bundle.derived_from_id))
        expansion = SourceArchiveExpansion.objects.filter(revision=current).first()
        if expansion:
            pending.append(get_bundle_revision(user, expansion.archive_file.revision_id))
        submission = SourceEditSubmission.objects.filter(revision=current).first()
        if submission:
            pending.append(get_bundle_revision(user, submission.baseline_id))
            if submission.archive_file_id:
                pending.append(get_bundle_revision(user, submission.archive_file.revision_id))
    return sorted(rows, key=lambda row: row["source_revision_id"])


def review_value(reviews, subject):
    review = reviews.get(subject)
    return (
        review.model_dump(mode="json")
        if review
        else {
            "subject": subject,
            "decision": "unknown",
            "basis": "",
        }
    )


def build_package(user, p):
    user, root, selected, closure, selection = selection_context(user, p)
    captured, excluded = captured_closure(user, root, selected, closure, selection)
    source_files, opaque = collect_sources(user, captured)
    if excluded:
        # Frozen pins can flatten a dependency's own closure. Omitting only its root
        # would risk including unrelated parent data from that flattened closure.
        raise Unsupported(
            "Selected scope requires context-external design data; export an "
            "independent boundary revision or review a different selection."
        )
    # Frozen canonical bytes may preserve opaque extension/native references. They are
    # data, not evidence that a native tool or external dependency was reconstructed.
    unsupported = sorted(
        {
            revision.definition.kind
            for revision in captured.values()
            if revision.definition.kind
            not in {
                "assembly",
                "cable",
                "connector_body",
                "pinout",
                "interface_map",
                "wire_stock",
                "workshop_profile",
                "end_preparation_profile",
            }
        }
    )
    reviews = {review.subject: review for review in p.rights_reviews}
    subjects = {f"design:{rid}" for rid in captured} | {
        f"source:{rid}:{path}" for rid, path in source_files
    }
    if set(reviews) - subjects:
        raise ValidationFailed("Rights review must identify an exact selected package subject.")
    if p.purpose == "distribution":
        for revision in captured.values():
            authorize(user, revision.definition.project_id, Perm.DESIGN_FREEZE)
        for file in source_files.values():
            authorize(user, file.revision.bundle.project_id, Perm.DESIGN_FREEZE)
        if any(review_value(reviews, subject)["decision"] != "permitted" for subject in subjects):
            raise ValidationFailed(
                "Distribution requires an explicit permitted review for every subject."
            )
    files = {}
    designs, sources, unresolved = [], [], []
    for rid in sorted(captured, key=str):
        revision = captured[rid]
        path = f"designs/{rid}.json"
        raw = bytes(revision.snapshot.canonical)
        if digest(raw) != revision.snapshot.sha256:
            raise ValidationFailed("Selected design bytes failed integrity verification.")
        subject = f"design:{rid}"
        review = review_value(reviews, subject)
        # Private review is permitted by current project authority; withheld declaration
        # always prevents export. Unknown distribution rights remain visible.
        if review["decision"] == "withheld":
            raise ValidationFailed("A required selected design is withheld from export.")
        if sum(len(data) for data in files.values()) + len(raw) > MAX_BYTES:
            raise ValidationFailed("Selected package exceeds the supported byte limit.")
        files[path] = raw
        designs.append(
            {
                "revision_id": str(rid),
                "snapshot_id": str(revision.snapshot_id),
                "definition_id": str(revision.definition_id),
                "kind": revision.definition.kind,
                "sha256": revision.snapshot.sha256,
                "path": path,
                "rights_review": review,
            }
        )
    for (rid, source_path), file in sorted(source_files.items()):
        subject = f"source:{rid}:{source_path}"
        review = review_value(reviews, subject)
        # Exact required file only; manifest hash provides provenance without revealing
        # a sibling's filenames, rights, bytes or a full source-bundle manifest.
        path = f"sources/{rid}/{source_path}"
        include = review["decision"] == "permitted"
        sources.append(
            {
                "source_revision_id": rid,
                "manifest_sha256": file.revision.manifest_sha256,
                "ancestry": source_ancestry(user, file.revision),
                "source_path": source_path,
                "sha256": file.blob.sha256,
                "bytes": file.blob.size,
                "media_type": file.media_type,
                "declared_rights": file.rights,
                "rights_review": review,
                "path": path if include else None,
                "status": "included_inert" if include else "omitted_pending_rights",
            }
        )
        if include:
            if sum(len(data) for data in files.values()) + file.blob.size > MAX_BYTES:
                raise ValidationFailed("Selected package exceeds the supported byte limit.")
            try:
                with blobstore.open_blob(file.blob.sha256) as stream:
                    data = stream.read(MAX_BYTES + 1)
            except OSError:
                raise ValidationFailed("Required selected source bytes unavailable.") from None
            if len(data) != file.blob.size or digest(data) != file.blob.sha256:
                raise ValidationFailed("Selected source bytes failed integrity verification.")
            files[path] = data
        else:
            unresolved.append(
                {"subject": subject, "reason": "Required source bytes omitted for rights."}
            )
    if opaque:
        unresolved.append(
            {"reason": "Source bundle reference lacks an exact selected file boundary."}
        )
    if "firmware" in unsupported:
        unresolved.append(
            {
                "reason": "Preserved firmware declarations and selected source files do not "
                "reconstruct a compiled firmware artifact.",
                "kinds": ["firmware"],
                "toolchain_support": "declared_not_verified",
                "compilation": "not_performed",
                "flashing": "not_performed",
            }
        )
    other_unsupported = [kind for kind in unsupported if kind != "firmware"]
    if other_unsupported:
        unresolved.append(
            {
                "reason": "Native/extension reconstruction unsupported for preserved kinds.",
                "kinds": other_unsupported,
            }
        )
    occurrences = occurrence_rows(selected, closure, selection)
    relationships, crossing = projected_relationships(closure, selection, captured)
    interfaces = boundary_interfaces(user, occurrences, captured)
    if any(row.get("boundary_exposure") == "unknown" for row in interfaces):
        unresolved.append({"reason": "Some selected boundary interfaces remain unknown."})
    manifest = {
        "format": "specmate.selected-assembly-package",
        "schema_version": "0.1",
        "purpose": p.purpose,
        "scope": {
            "root_revision_id": str(root.id),
            "root_snapshot_id": str(root.snapshot_id),
            "root_sha256": root.snapshot.sha256,
            "occurrence_path": list(selection),
            "selected_revision_id": str(selected.id),
            "selected_sha256": selected.snapshot.sha256,
        },
        "completeness": "limited" if unresolved else "complete_declared_data",
        "design_revisions": designs,
        "source_files": sources,
        "occurrences": occurrences,
        "relationships": relationships,
        "boundary_interfaces": interfaces,
        "boundary_crossings": crossing,
        "unresolved": unresolved,
        "reviewed_by_actor_id": str(user.pk),
        "rights": "explicit_declarations"
        if p.purpose == "distribution"
        else "private_review_only_distribution_not_authorized",
        "native_processing": "not_performed",
        "physical_qualification": "not_evaluated",
        "physical_continuity": "not_evaluated",
        "compatibility": "not_evaluated",
    }
    if p.purpose == "distribution" and unresolved:
        raise ValidationFailed("Required dependencies or boundary semantics remain unresolved.")
    files["review.html"] = document(manifest)
    files["README.txt"] = (
        b"Specmate selected assembly package\nOpen review.html locally; no server is required.\n"
        b"manifest.json identifies selected occurrences, exact design pins, source files,\n"
        b"boundary declarations, unresolved semantics and explicit rights decisions.\n"
        b"Files are inert preserved data. Never execute included sources merely because they\n"
        b"were exported. No compatibility, physical continuity or qualification is inferred.\n"
        b"Verify each file's SHA-256 and byte count against manifest.json before use.\n"
    )
    if len(files) > MAX_FILES or sum(len(data) for data in files.values()) > MAX_BYTES:
        raise ValidationFailed("Selected package exceeds the supported size limit.")
    manifest["files"] = [
        {"path": path, "sha256": digest(data), "bytes": len(data)}
        for path, data in sorted(files.items())
    ]
    manifest_data = canonical_bytes(manifest)
    if sum(len(data) for data in files.values()) + len(manifest_data) > MAX_BYTES:
        raise ValidationFailed("Selected package exceeds the supported size limit.")
    files["manifest.json"] = manifest_data
    return manifest, files, digest(manifest_data)


def document(manifest):
    # Static escaped HTML; no scripts, external assets, executable templates or parent data.
    def block(title, value):
        return f"<h2>{title}</h2><pre>{html.escape(json.dumps(value, indent=2))}</pre>"

    data = (
        "<!doctype html><html lang='en'><meta charset='utf-8'>"
        "<meta http-equiv='Content-Security-Policy' "
        "content=\"default-src 'none'; style-src 'none'\">"
        "<title>Selected assembly review</title><h1>Selected assembly review</h1>"
        f"<p>Completeness: {manifest['completeness']}. {manifest['rights']}.</p>"
        "<p>Inert preserved engineering declarations. Native processing was not performed. "
        "Compatibility, physical continuity and physical qualification are not evaluated.</p>"
        + block("Exact selected scope", manifest["scope"])
        + block("Occurrence addresses relative to selected boundary", manifest["occurrences"])
        + block("Declared boundary interfaces", manifest["boundary_interfaces"])
        + block("External boundary unknowns", manifest["boundary_crossings"])
        + block("Internal declared relationships", manifest["relationships"])
        + block("Exact design revisions and rights", manifest["design_revisions"])
        + block("Exact required source files and rights", manifest["source_files"])
        + block("Unresolved items", manifest["unresolved"])
        + "</html>"
    )
    return data.encode()


def archive(user, p):
    manifest, files, sha256 = build_package(user, p)
    if sha256 != p.reviewed_sha256:
        raise Conflict("Package review changed; inspect and review the exact selection again.")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as target:
        for path, data in sorted(files.items()):
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100444 << 16
            target.writestr(info, data)
    return stream.getvalue(), sha256, manifest
