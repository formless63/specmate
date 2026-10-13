"""Project reviewed instructions onto explicitly mapped exact cable endpoints."""

from specmate.cables.queries import inspect_revision as inspect_cable
from specmate.catalog_matching.queries import current_actor
from specmate.end_preparation.contracts import BondExpectation, ContactTarget
from specmate.end_preparation.queries import LAYER_KINDS, profile_revision
from specmate.operations import ValidationFailed
from specmate.queries import get_revision


def unresolved(instruction):
    missing = []
    if instruction.treatment == "unknown":
        missing.append("treatment")
    if isinstance(instruction, BondExpectation):
        if instruction.treatment == "bond" and instruction.target is None:
            missing.append("bond_target")
    else:
        # Retaining a feature does not choose a new size. Removing or insulating at
        # an end still needs an explicit extent; omission is never a whole-feature default.
        dimensional = instruction.treatment in {
            "strip_back",
            "remove",
            "insulate",
            "trim",
            "form_lead",
            "fold_back",
            "prepare_termination",
        }
        if dimensional:
            missing.extend(
                name
                for name in ("nominal_mm", "minus_mm", "plus_mm")
                if getattr(instruction.length, name) is None
            )
        elif instruction.treatment == "unknown":
            missing.extend(
                name
                for name in ("nominal_mm", "minus_mm", "plus_mm")
                if getattr(instruction.length, name) is None
            )
    return missing


def apply_profile(user, request):
    user = current_actor(user)
    # Both complete frozen closures must be current before mapping diagnostics.
    cable_revision = get_revision(user, request.cable_revision_id)
    get_revision(user, request.profile_revision_id)
    revision, profile, stock, elements, _ = profile_revision(user, request.profile_revision_id)
    cable = inspect_cable(user, cable_revision.id)
    if str(profile.stock_revision_id) != cable["cable"]["stock_revision_id"]:
        raise ValidationFailed("End preparation must pin the cable's exact stock revision.")
    endpoints = {e["local_id"]: e for e in cable["endpoints"]}
    mapping = {"a": request.a_endpoint_id, "b": request.b_endpoint_id}
    if len(set(mapping.values())) != 2 or set(mapping.values()) != set(endpoints):
        raise ValidationFailed("Map each profile end to a distinct exact cable endpoint ID.")
    ends = []
    for end_id, endpoint_id in mapping.items():
        end = getattr(profile, end_id)
        endpoint = endpoints[endpoint_id]
        rows, missing_instructions = project_end(end, elements, endpoint, request.mapping_review)
        ends.append(
            {
                "profile_end": end_id,
                "endpoint": endpoint,
                "review": end.review,
                "review_basis": end.review_basis,
                "instructions": rows,
                "missing_instructions": missing_instructions,
            }
        )
    return {
        "cable_revision_id": str(cable_revision.id),
        "cable_sha256": cable_revision.snapshot.sha256,
        "profile_revision_id": str(revision.id),
        "profile_sha256": revision.snapshot.sha256,
        "stock_revision_id": str(stock.id),
        "stock_sha256": stock.snapshot.sha256,
        "mapping_basis": request.mapping_basis,
        "mapping_review": request.mapping_review,
        "ends": ends,
        "authority": "human_preparation_intent",
        "application": "read_only_instructions",
        "stock_facts_written": False,
        "topology_written": False,
        "workshop_defaults_applied": False,
        "actual_bonds": "not_evaluated",
        "measured_preparation": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }


def project_end(end, elements, endpoint, mapping_review):
    rows = []
    for instruction in end.instructions:
        if isinstance(instruction, BondExpectation) and isinstance(
            instruction.target, ContactTarget
        ):
            if (
                endpoint is not None
                and str(instruction.target.body_revision_id) != endpoint["body_revision_id"]
            ):
                raise ValidationFailed(
                    "Expected bond body pin must match this mapped endpoint exactly."
                )
        missing = unresolved(instruction)
        if (
            isinstance(instruction, BondExpectation)
            and isinstance(instruction.target, ContactTarget)
            and endpoint is None
        ):
            missing.append("physical_end_endpoint")
        rows.append(
            {
                "instruction": instruction.model_dump(mode="json"),
                "element_kind": elements[instruction.element_path].kind,
                "unresolved": missing,
                "status": "unreviewed_intent"
                if end.review != "reviewed" or mapping_review != "reviewed"
                else "incomplete_intent"
                if missing
                else "reviewed_intent",
                "bond_created": False,
            }
        )
    covered = {(i.kind, i.element_path) for i in end.instructions}
    missing_instructions = []
    for path, element in elements.items():
        kinds = []
        if element.kind in LAYER_KINDS:
            kinds.append("layer_strip")
        if element.kind == "drain":
            kinds.append("drain_treatment")
        if element.kind == "shield":
            kinds.append("shield_lead")
        if element.kind in {"drain", "shield"}:
            kinds.append("bond_expectation")
        missing_instructions.extend(
            {"element_path": path, "kind": kind, "status": "unknown"}
            for kind in kinds
            if (kind, path) not in covered
        )
    return rows, missing_instructions


def apply_harness_profile(user, request):
    from specmate.harnesses.queries import read_revision

    user = current_actor(user)
    # All supplied complete snapshots precede section, mapping and stock diagnostics.
    get_revision(user, request.harness_revision_id)
    get_revision(user, request.profile_revision_id)
    harness_revision, harness = read_revision(user, request.harness_revision_id)
    revision, profile, stock, elements, _ = profile_revision(user, request.profile_revision_id)
    section = harness.sections.get(request.section_id)
    if section is None:
        raise ValidationFailed("Physical section is absent from this exact harness revision.")
    if profile.stock_revision_id != section.stock_revision_id:
        raise ValidationFailed(
            "End preparation must pin the physical section's exact stock revision."
        )
    physical_ends = {end.local_id: end for end in section.physical_ends}
    result = {
        "schema_version": "0.1",
        "harness_revision_id": str(harness_revision.id),
        "harness_sha256": harness_revision.snapshot.sha256,
        "section_id": section.local_id,
        "physical_piece_count": 1,
        "profile_revision_id": str(revision.id),
        "profile_sha256": revision.snapshot.sha256,
        "stock_revision_id": str(stock.id),
        "stock_sha256": stock.snapshot.sha256,
        "mapping_basis": request.mapping_basis,
        "mapping_review": request.mapping_review,
        "declared_physical_ends": [end.model_dump(mode="json") for end in section.physical_ends],
        "ends": [],
        "unresolved": [],
        "status": "mapped_intent",
        "authority": "human_preparation_intent",
        "application": "read_only_instructions",
        "stock_facts_written": False,
        "topology_written": False,
        "workshop_defaults_applied": False,
        "actual_bonds": "not_evaluated",
        "measured_preparation": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }
    if len(physical_ends) != 2:
        result["status"] = "unresolved"
        result["unresolved"] = [
            "Physical ends are undeclared or this two-end profile cannot cover the declared "
            "physical ends. No ends were inferred from segments or breakout connectivity."
        ]
        return result
    mapping = {"a": request.a_physical_end_id, "b": request.b_physical_end_id}
    if any(value is None for value in mapping.values()):
        result["status"] = "unresolved"
        result["unresolved"] = [
            "Choose both exact physical end IDs deliberately; no mapping is inferred."
        ]
        return result
    if len(set(mapping.values())) != 2 or set(mapping.values()) != set(physical_ends):
        raise ValidationFailed(
            "Map both profile ends to distinct exact physical ends of this section."
        )
    for end_id, physical_id in mapping.items():
        physical = physical_ends[physical_id]
        endpoint = None
        if physical.endpoint_id is not None:
            pin, body, pinout = harness.endpoints[physical.endpoint_id]
            endpoint = {
                **pin.model_dump(mode="json"),
                "body": body.model_dump(mode="json"),
                "pinout": pinout.model_dump(mode="json"),
            }
        end = getattr(profile, end_id)
        review = (
            "reviewed" if request.mapping_review == physical.review == "reviewed" else "unreviewed"
        )
        rows, missing = project_end(end, elements, endpoint, review)
        result["ends"].append(
            {
                "profile_end": end_id,
                "physical_end": physical.model_dump(mode="json"),
                "endpoint": endpoint,
                "review": end.review,
                "review_basis": end.review_basis,
                "instructions": rows,
                "missing_instructions": missing,
            }
        )
    return result
