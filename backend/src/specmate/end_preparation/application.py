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
        rows = []
        for instruction in end.instructions:
            if isinstance(instruction, BondExpectation) and isinstance(
                instruction.target, ContactTarget
            ):
                if str(instruction.target.body_revision_id) != endpoint["body_revision_id"]:
                    raise ValidationFailed(
                        "Expected bond body pin must match this mapped endpoint exactly."
                    )
            missing = unresolved(instruction)
            rows.append(
                {
                    "instruction": instruction.model_dump(mode="json"),
                    "element_kind": elements[instruction.element_path].kind,
                    "unresolved": missing,
                    "status": "unreviewed_intent"
                    if end.review != "reviewed" or request.mapping_review != "reviewed"
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
