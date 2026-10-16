"""One exact projection for every coordinated output. No inferred engineering facts."""

import json
from decimal import Decimal, DecimalException, Inexact, Rounded, localcontext

from pydantic import ValidationError as PydanticValidationError

from specmate.assemblies.queries import get_snapshot
from specmate.bom.queries import inspect_revision as inspect_bom
from specmate.cable_test_intent.queries import result as inspect_tests
from specmate.cables.queries import inspect_revision as inspect_cable
from specmate.catalog_matching.queries import current_actor
from specmate.design.operations import canonical_bytes
from specmate.design.pins import pin_workspace
from specmate.end_preparation.application import apply_harness_profile, apply_profile
from specmate.end_preparation.contracts import ApplyHarnessProfile, ApplyProfile
from specmate.end_preparation.queries import profile_revision as end_profile_revision
from specmate.harnesses.queries import inspect_revision as inspect_harness
from specmate.interfaces.wiring import is_section_revision
from specmate.inventory.contracts import QUANTITY_CONTEXT, Quantity
from specmate.operations import ValidationFailed
from specmate.preparation.calculation import compute
from specmate.preparation.contracts import ComputeCuts
from specmate.preparation_documents.contracts import DOCUMENTS, FORMAT, GENERATOR
from specmate.queries import get_revision
from specmate.selected_packages.queries import collect_sources, digest, source_ancestry

MAX_REVISIONS = 1024
MAX_CONTEXTS = 256
MAX_ROWS = 4096
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_SOURCE_FILES = 4000


def references(configuration):
    ids = {configuration.root_revision_id}
    if configuration.bom_plan_revision_id:
        ids.add(configuration.bom_plan_revision_id)
    for binding in configuration.bindings:
        ids.update(p.profile_revision_id for p in binding.cut_profiles)
        ids.update(p.profile_revision_id for p in binding.end_profiles)
        if binding.test_plan_revision_id:
            ids.add(binding.test_plan_revision_id)
    return ids


def authorize_inputs(user, configuration, supplementary=()):
    """Resolve all owning/catalog/design/source closure before projection diagnostics."""
    user = current_actor(user)
    captured = {}
    root = get_revision(user, configuration.root_revision_id)
    # Every bound plan/profile and supplementary pin stays in the root's workspace; a
    # foreign revision reads as missing before any projection or receipt write.
    with pin_workspace(root.definition.workspace_id):
        pending = list(references(configuration) | set(supplementary))
        while pending:
            rid = pending.pop()
            if rid in captured:
                continue
            revision = get_revision(user, rid)
            captured[revision.id] = revision
            pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
            if len(captured) > MAX_REVISIONS:
                raise ValidationFailed("Document inputs exceed the bounded revision limit.")
        files, opaque = collect_sources(user, captured)
    if sum(len(r.snapshot.canonical) for r in captured.values()) > MAX_INPUT_BYTES:
        raise ValidationFailed("Canonical document inputs exceed the bounded byte limit.")
    if len(files) > MAX_SOURCE_FILES:
        raise ValidationFailed("Document source pins exceed the bounded file limit.")
    return user, captured, files, opaque


def decimal_total(length, quantity):
    if length is None or quantity is None:
        return None
    try:
        with localcontext(QUANTITY_CONTEXT) as context:
            context.traps[Inexact] = context.traps[Rounded] = True
            value = Decimal(length) * quantity
            Quantity(amount=value, unit="mm")
            return format(value, "f")
    except (DecimalException, PydanticValidationError, ValueError):
        raise ValidationFailed("Document totals exceed exact supported quantity bounds.") from None


def _signal_text(signal):
    if not signal:
        return None
    return {"name": signal["name"], "type": signal["type"]}


def termination_rows(inspected):
    """One row per declared termination: conductor, layer target, signals and part notes.

    Signals are the connector contacts' typed signals (for a pad or inline lead, those of
    the contacts it is declared to reach). Part notes are the declared board-path or inline
    parts at that terminal. A missing signal stays null (unknown), never inferred.
    """
    endpoints = {e["local_id"]: e for e in inspected["endpoints"]}
    labels = {c["element_path"]: c["label"] for c in inspected["conductors"]}
    rows = []
    for t in inspected["terminations"]:
        endpoint = endpoints[t["endpoint_id"]]
        layers = {layer["layer_id"]: layer for layer in endpoint["resolved_stack"]["layers"]}
        layer = layers.get(t["layer_id"], {})
        notes = []
        if layer.get("kind") == "board":
            notes = [
                p["summary"]
                for p in layer.get("paths", [])
                if p["via"] != "copper"
                and t["terminal_id"] in (p["from_terminal"], p["to_terminal"])
            ]
        elif layer.get("kind") == "inline":
            part_id = t["terminal_id"].split(".", 1)[0]
            notes = [p["summary"] for p in layer.get("parts", []) if p["local_id"] == part_id]
        for join in endpoint["resolved_stack"]["joins"]:
            if join.get("through") and any(
                member["layer_id"] == t["layer_id"] and member["terminal_id"] == t["terminal_id"]
                for member in (join["a"], join["b"], join["through"])
            ):
                carrier = join["through"]
                notes.append(
                    f"Same solder point {join['local_id']} through "
                    f"{carrier['layer_id']} / {carrier['label']}: {join['basis']}"
                )
        if t["contact_id"] is not None:
            targets = [
                {
                    **(
                        {"layer_id": t["layer_id"]}
                        if endpoint["resolved_stack"].get("graph_version") == "0.2"
                        else {}
                    ),
                    "contact_id": t["contact_id"],
                    "label": t["terminal_label"],
                    "signal": _signal_text(t["signal"]),
                    "status": "declared",
                }
            ]
        else:
            targets = [
                {
                    **({"layer_id": r["layer_id"]} if "layer_id" in r else {}),
                    "contact_id": r["contact_id"],
                    "label": r["label"],
                    "signal": _signal_text(r["signal"]),
                    "status": r["status"],
                }
                for r in t["reaches"]
            ]
        rows.append(
            {
                "endpoint_id": t["endpoint_id"],
                "endpoint_label": endpoint.get("label") or t["endpoint_id"],
                "stock_end": endpoint.get("stock_end", "unknown"),
                "element_path": t["element_path"],
                "element_label": labels.get(t["element_path"]),
                "layer_id": t["layer_id"],
                "layer_kind": t["layer_kind"],
                "target_label": t["terminal_label"],
                "contacts": targets,
                "part_notes": notes,
                "basis": t["basis"],
            }
        )
    rows.sort(key=lambda r: (r["endpoint_id"], r["layer_id"], r["target_label"], r["element_path"]))
    return rows


def project(user, configuration):
    user, captured, source_files, opaque = authorize_inputs(user, configuration)
    root = captured[configuration.root_revision_id]
    root_pin = {
        "revision_id": str(root.id),
        "snapshot_id": str(root.snapshot_id),
        "snapshot_sha256": root.snapshot.sha256,
        "definition_id": str(root.definition_id),
        "name": root.definition.name,
        "kind": root.definition.kind,
        "number": root.number,
    }
    contexts = {(): root}
    if root.definition.kind == "assembly":
        _, closure = get_snapshot(user, root.snapshot_id)
        contexts.update({path: node.revision for path, node in closure.nodes.items()})
    bindings = {tuple(b.occurrence_path): b for b in configuration.bindings}
    for path in bindings:
        if path not in contexts or contexts[path].definition.kind not in {"cable", "harness"}:
            raise ValidationFailed("A document binding must select an exact cable/harness context.")
    wiring = [
        (path, revision)
        for path, revision in contexts.items()
        if revision.definition.kind in {"cable", "harness"}
    ]
    if len(wiring) > MAX_CONTEXTS:
        raise ValidationFailed("Document wiring contexts exceed the bounded limit.")
    bom = None
    policies = {}
    if configuration.bom_plan_revision_id:
        bom = inspect_bom(user, configuration.bom_plan_revision_id, "procurement")
        if bom["bom"]["assembly_revision_id"] != str(root.id):
            raise ValidationFailed("BOM policy must pin the document set's exact root revision.")
        if bom["bom"]["quantity"]["amount"] != configuration.quantity:
            raise ValidationFailed("Document and frozen BOM quantities must agree exactly.")
        policies = {tuple(p["path"]): p["decision"] for p in bom["bom"]["policies"]}
    elif root.definition.kind != "assembly":
        policies[()] = configuration.standalone_decision

    def disposition(path):
        for size in range(len(path) + 1):
            prefix = path[:size]
            decision = policies.get(prefix, "unknown")
            if decision != "make":
                return decision, list(prefix)
        return "make", None

    revisions = [
        {
            "revision_id": str(r.id),
            "definition_id": str(r.definition_id),
            "snapshot_id": str(r.snapshot_id),
            "snapshot_sha256": r.snapshot.sha256,
            "kind": r.definition.kind,
            "name": r.definition.name,
            "number": r.number,
        }
        for r in sorted(captured.values(), key=lambda r: str(r.id))
    ]
    sources = [
        {
            "bundle_revision_id": rid,
            "path": path,
            "sha256": file.blob.sha256,
            "rights": file.rights,
            "source_manifest_sha256": file.revision.manifest_sha256,
            "ancestry": source_ancestry(user, file.revision),
        }
        for (rid, path), file in sorted(source_files.items())
    ]
    review_map = {r.subject: r.model_dump(mode="json") for r in configuration.rights_reviews}
    subjects = {"design:" + r["revision_id"] for r in revisions} | {
        "source:" + f["bundle_revision_id"] + ":" + f["path"] for f in sources
    }
    if set(review_map) - subjects:
        raise ValidationFailed("Rights reviews must identify exact document input subjects.")
    rights = [
        {
            "subject": subject,
            "review": review_map.get(subject, {"decision": "unknown", "basis": ""}),
        }
        for subject in sorted(subjects)
    ]
    if configuration.purpose == "distribution":
        if any(row["review"]["decision"] != "permitted" for row in rights) or opaque:
            raise ValidationFailed(
                "Distribution requires explicit permitted rights for all exact inputs."
            )
        if (
            configuration.output_rights.lower() in {"unknown", "unresolved"}
            or not configuration.output_rights_basis
        ):
            raise ValidationFailed(
                "Generated distribution outputs require declared rights and basis."
            )
    common = {
        "format": FORMAT,
        "generator": "specmate.preparation-documents/4"
        if configuration.document_settings
        else GENERATOR,
        "root": root_pin,
        "configuration": configuration.model_dump(mode="json"),
        "revision_pins": revisions,
        "source_pins": sources,
        "opaque_source_references": sorted(opaque),
        "rights_reviews": rights,
        "distribution": "reviewed_declarations_only"
        if configuration.purpose == "distribution"
        else "not_authorized",
        "physical_test": "not_performed",
        "physical_continuity": "not_evaluated",
        "fit": "not_evaluated",
        "physical_qualification": False,
    }
    common_hash = digest(canonical_bytes(common))
    cuts, preparations, terminations, tests, schematics, specifications, issues = (
        [],
        [],
        [],
        [],
        [],
        [],
        [],
    )
    if opaque:
        issues.append(
            {
                "path": [],
                "code": "source_file_boundary",
                "status": "unknown",
                "message": (
                    "Some source references have no exact file boundary; "
                    "rights/semantics unresolved."
                ),
            }
        )
    if not wiring:
        issues.append(
            {
                "path": [],
                "code": "wiring_scope",
                "status": "unknown",
                "message": "No supported cable/harness scope; wiring outputs remain unassessed.",
            }
        )
    for path, revision in wiring:
        address = {
            "root_snapshot_id": str(root.snapshot_id),
            "path": list(path),
            "revision_id": str(revision.id),
            "snapshot_sha256": revision.snapshot.sha256,
        }
        decision, boundary = disposition(path)
        q = configuration.quantity
        workshop_quantity = q if decision == "make" else 0 if decision == "buy" else None
        binding = bindings.get(path)
        if decision == "unknown":
            issues.append(
                {
                    "path": list(path),
                    "code": "workshop_boundary",
                    "status": "unknown",
                    "message": "Make/buy disposition is unassessed; manufacturing counts unknown.",
                }
            )
        inspected = (
            inspect_cable(user, revision.id)
            if revision.definition.kind == "cable"
            else inspect_harness(user, revision.id, q)
        )
        specifications.append(
            {
                "address": address,
                "declarations": inspected,
                "disposition": decision,
                "boundary_path": boundary,
                "design_quantity": q,
                "workshop_quantity": workshop_quantity,
            }
        )
        if revision.definition.kind == "cable" and not is_section_revision(revision):
            cable = inspected["cable"]
            stock_cut = next(r for r in inspected["lengths"]["rows"] if r["target"] == "stock_cut")
            pieces = [
                {
                    "section_id": None,
                    "stock_revision_id": cable["stock_revision_id"],
                    "segment_ids": [],
                    "length_mm": stock_cut["declaration"]["amount_mm"],
                    "cut_basis": stock_cut["declaration"]["explanation"],
                }
            ]
            cuts.extend(
                {
                    "address": address,
                    "row_kind": "declared_conductor_cut",
                    "element_path": row["target"].removeprefix("conductor:"),
                    "length_mm": row["declaration"]["amount_mm"],
                    "cut_basis": row["declaration"]["explanation"],
                    "design_total_mm": decimal_total(row["declaration"]["amount_mm"], q),
                    "workshop_total_mm": decimal_total(
                        row["declaration"]["amount_mm"], workshop_quantity
                    ),
                    "adds_stock_pieces": False,
                    "physical_continuity": "not_evaluated",
                }
                for row in inspected["lengths"]["rows"]
                if row["target"].startswith("conductor:")
            )
            terminations.append(
                {
                    "address": address,
                    "assignments": cable["assignments"],
                    "rows": termination_rows(inspected),
                    "unassigned": [
                        {"element_path": r["element_path"], "endpoint_id": e["endpoint_id"]}
                        for r in inspected["conductors"]
                        for e in r["ends"]
                        if e["assignment"] is None
                    ],
                    "declared_assignment_count": len(cable["assignments"]),
                    "design_assignment_count": None if q is None else len(cable["assignments"]) * q,
                    "workshop_assignment_count": None
                    if workshop_quantity is None
                    else len(cable["assignments"]) * workshop_quantity,
                    "authority": "declared_topology",
                    "physical_continuity": "not_evaluated",
                }
            )
            schematics.append(
                {
                    "address": address,
                    "endpoints": cable["endpoints"],
                    "assignments": cable["assignments"],
                    "conductors": inspected["conductors"],
                    "meaning": "declared_terminations_only_no_inferred_connectivity",
                }
            )
        else:
            harness = inspected.get("harness") or inspected["cable"]
            pieces = [
                {
                    "section_id": s["local_id"],
                    "stock_revision_id": s["stock_revision_id"],
                    "segment_ids": [
                        g["local_id"]
                        for g in harness["segments"]
                        if g["section_id"] == s["local_id"]
                    ],
                    "length_mm": s["planned_cut_length_mm"],
                    "cut_basis": s["cut_basis"],
                }
                for s in harness["sections"]
            ]
            terminations.append(
                {
                    "address": address,
                    "relationships": inspected["declared_relationships"],
                    **(
                        {"pigtail_preparations": inspected["pigtail_preparations"]}
                        if inspected.get("pigtail_preparations")
                        else {}
                    ),
                    **(
                        {"stock_construction_bonds": inspected["construction_bonds"]}
                        if inspected.get("construction_bonds")
                        else {}
                    ),
                    "breakout_fates": inspected["breakout_fates"],
                    "declared_relationship_count": len(inspected["declared_relationships"]),
                    "design_relationship_count": None
                    if q is None
                    else len(inspected["declared_relationships"]) * q,
                    "workshop_relationship_count": None
                    if workshop_quantity is None
                    else len(inspected["declared_relationships"]) * workshop_quantity,
                    "authority": "declared_relationships",
                    "physical_continuity": "not_evaluated",
                }
            )
            schematics.append(
                {
                    "address": address,
                    "terminals": inspected["terminals"],
                    "relationships": inspected["declared_relationships"],
                    **(
                        {"pigtail_preparations": inspected["pigtail_preparations"]}
                        if inspected.get("pigtail_preparations")
                        else {}
                    ),
                    **(
                        {"stock_construction_bonds": inspected["construction_bonds"]}
                        if inspected.get("construction_bonds")
                        else {}
                    ),
                    "meaning": "declared_relationships_and_stock_construction_only"
                    if inspected.get("construction_bonds") or inspected.get("pigtail_preparations")
                    else "declared_relationships_only",
                }
            )
        for piece in pieces:
            cuts.append(
                {
                    "address": address,
                    **piece,
                    "row_kind": "declared_physical_piece",
                    "disposition": decision,
                    "boundary_path": boundary,
                    "design_piece_count": q,
                    "workshop_piece_count": workshop_quantity,
                    "design_total_mm": decimal_total(piece["length_mm"], q),
                    "workshop_total_mm": decimal_total(piece["length_mm"], workshop_quantity),
                    "status": "unknown_length" if piece["length_mm"] is None else "declared_length",
                    "basis": "Each physical section counts once; logical segments add no pieces.",
                }
            )
        if binding and binding.cut_profiles:
            calculated = compute(
                user,
                ComputeCuts(revision_id=revision.id, applications=binding.cut_profiles, quantity=q),
            )
            for section in calculated["unprofiled_sections"]:
                issues.append(
                    {
                        "path": list(path),
                        "section_id": section,
                        "code": "cut_profile",
                        "status": "unknown",
                        "message": "No arithmetic profile bound to this physical section.",
                    }
                )
            if any(r["status"] != "calculated_suggestion" for r in calculated["rows"]):
                issues.append(
                    {
                        "path": list(path),
                        "code": "cut_calculation",
                        "status": "unknown",
                        "message": "Some formulas are unreviewed or have unresolved inputs.",
                    }
                )
            cuts.extend(
                {
                    "address": address,
                    **r,
                    "suggestion_count": q,
                    "row_kind": "reviewed_suggestion",
                    "disposition": decision,
                    "workshop_total_mm": decimal_total(r["cut_mm"], workshop_quantity),
                    "stock_facts_written": False,
                }
                for r in calculated["rows"]
            )
        else:
            issues.append(
                {
                    "path": list(path),
                    "code": "cut_profile",
                    "status": "unknown",
                    "message": "No arithmetic profile bound; only frozen declared cuts are shown.",
                }
            )
        applied_sections = set()
        for end in binding.end_profiles if binding else []:
            applied_sections.add(end.section_id)
            if end.section_id not in {p["section_id"] for p in pieces}:
                raise ValidationFailed("End preparation must bind an exact physical section.")
            _, _, profile_stock, _, _ = end_profile_revision(user, end.profile_revision_id)
            piece = next(p for p in pieces if p["section_id"] == end.section_id)
            if str(profile_stock.id) != piece["stock_revision_id"]:
                raise ValidationFailed("End preparation must pin the section's exact stock.")
            if revision.definition.kind == "cable" and not is_section_revision(revision):
                if end.a_end_id is None or end.b_end_id is None:
                    projected = {
                        "status": "unresolved",
                        "message": "Explicit endpoint mapping is missing.",
                    }
                else:
                    projected = apply_profile(
                        user,
                        ApplyProfile(
                            cable_revision_id=revision.id,
                            profile_revision_id=end.profile_revision_id,
                            a_endpoint_id=end.a_end_id,
                            b_endpoint_id=end.b_end_id,
                            mapping_review=end.mapping_review,
                            mapping_basis=end.mapping_basis,
                        ),
                    )
            else:
                projected = apply_harness_profile(
                    user,
                    ApplyHarnessProfile(
                        harness_revision_id=revision.id,
                        section_id=end.section_id,
                        profile_revision_id=end.profile_revision_id,
                        a_physical_end_id=end.a_end_id,
                        b_physical_end_id=end.b_end_id,
                        mapping_review=end.mapping_review,
                        mapping_basis=end.mapping_basis,
                    ),
                )
            if (
                projected.get("status") == "unresolved"
                or end.mapping_review != "reviewed"
                or any(
                    e.get("missing_instructions")
                    or e.get("review") != "reviewed"
                    or any(i["status"] != "reviewed_intent" for i in e.get("instructions", []))
                    for e in projected.get("ends", [])
                )
            ):
                issues.append(
                    {
                        "path": list(path),
                        "section_id": end.section_id,
                        "code": "end_preparation",
                        "status": "unknown",
                        "message": "End mapping/instructions contain unreviewed or missing intent.",
                    }
                )
            preparations.append(
                {
                    "address": address,
                    "section_id": end.section_id,
                    "profile_revision_id": str(end.profile_revision_id),
                    "projection": projected,
                }
            )
        for piece in pieces:
            if piece["section_id"] not in applied_sections:
                issues.append(
                    {
                        "path": list(path),
                        "section_id": piece["section_id"],
                        "code": "missing_end_preparation",
                        "status": "unknown",
                        "message": "No exact per-end preparation profile is bound.",
                    }
                )
                preparations.append(
                    {
                        "address": address,
                        "section_id": piece["section_id"],
                        "status": "unknown",
                        "message": (
                            "No per-end preparation bound; stripping/bonds remain unassessed."
                        ),
                    }
                )
        if binding and binding.test_plan_revision_id:
            result = inspect_tests(user, binding.test_plan_revision_id)
            plan = result["test_plan"]
            if (
                plan["root_revision_id"] != str(root.id)
                or plan["occurrence_path"] != list(path)
                or plan["cable_revision_id"] != str(revision.id)
            ):
                raise ValidationFailed(
                    "Test intent must pin this exact root/context/cable revision."
                )
            if not plan["pairs"]:
                issues.append(
                    {
                        "path": list(path),
                        "code": "empty_test_intent",
                        "status": "unknown",
                        "message": "Authored plan has no test-pair expectations.",
                    }
                )
            tests.append(
                {"address": address, "declarations": result, "physical_test": "not_performed"}
            )
        else:
            issues.append(
                {
                    "path": list(path),
                    "code": "missing_test_intent",
                    "status": "unknown",
                    "message": "No exact authored test intent is bound.",
                }
            )
            tests.append(
                {
                    "address": address,
                    "status": "unknown",
                    "message": "No exact authored test intent bound.",
                    "physical_test": "not_performed",
                    "physical_continuity": "not_evaluated",
                }
            )
    declarations = [
        {
            "revision_id": str(r.id),
            "snapshot_sha256": r.snapshot.sha256,
            "kind": r.definition.kind,
            "content": json.loads(bytes(r.snapshot.canonical))["content"],
        }
        for r in sorted(captured.values(), key=lambda r: str(r.id))
    ]
    sections = {
        "revision_specifications": declarations,
        "specifications": specifications,
        "schematic": schematics,
        "cut_preparation": cuts,
        "end_preparation": preparations,
        "terminations": terminations,
        "test_intent": tests,
        "procurement": bom,
        "issues": issues,
    }
    if (
        sum(len(value) for value in (cuts, preparations, terminations, tests, specifications))
        > MAX_ROWS
    ):
        raise ValidationFailed("Coordinated document row limit exceeded.")
    document_assessments = {
        name: {"status": "declared_with_unknowns", "physical_qualification": "not_evaluated"}
        for name in DOCUMENTS
    }
    document_assessments["specifications.json"]["status"] = "retained_declarations"
    for name in DOCUMENTS[1:]:
        document_assessments[name]["limitations"] = list(issues)
    document_assessments["terminations.json"]["unassigned_count"] = sum(
        len(t.get("unassigned", [])) for t in terminations
    )
    document_assessments["cut-preparation.csv"]["missing_end_profiles"] = [
        {"address": p["address"], "section_id": p["section_id"]}
        for p in preparations
        if p.get("status") == "unknown"
    ]
    document_assessments["test-intent.json"]["missing_or_empty_intent"] = [
        t["address"]
        for t in tests
        if t.get("status") == "unknown"
        or not t.get("declarations", {}).get("test_plan", {}).get("pairs")
    ]
    if not wiring:
        for name in DOCUMENTS[1:]:
            document_assessments[name]["status"] = "unknown_wiring_scope"
    return {
        "document_assessments": document_assessments,
        "inputs": common,
        "inputs_sha256": common_hash,
        "sections": sections,
        "readiness": "declared_with_unknowns"
        if issues
        or any(t.get("status") == "unknown" for t in tests)
        or any(p.get("status") == "unknown" for p in preparations)
        else "declared_inputs_only",
    }
