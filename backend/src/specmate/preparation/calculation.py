"""One bounded exact arithmetic implementation for all preparation consumers."""

from decimal import Decimal, DecimalException, Inexact, Rounded, localcontext

from pydantic import ValidationError

from specmate.cables.queries import inspect_revision as inspect_cable
from specmate.catalog_matching.queries import current_actor
from specmate.design.pins import pin_workspace
from specmate.harnesses.queries import read_revision as read_harness
from specmate.interfaces.wiring import is_section_revision
from specmate.inventory.contracts import QUANTITY_CONTEXT, Quantity
from specmate.operations import ValidationFailed
from specmate.preparation.queries import profile_revision
from specmate.queries import get_revision


def exact_result(base, allowances, quantity):
    if base is None or any(a.amount_mm is None for a in allowances):
        return None, None
    try:
        with localcontext(QUANTITY_CONTEXT) as context:
            context.traps[Inexact] = True
            context.traps[Rounded] = True
            result = Decimal(base)
            for allowance in allowances:
                result += -allowance.amount_mm if allowance.kind == "trim" else allowance.amount_mm
            if result <= 0:
                raise ValueError("Nonpositive cut result.")
            Quantity(amount=result, unit="mm")
            total = None if quantity is None else result * quantity
            if total is not None:
                Quantity(amount=total, unit="mm")
            return format(result, "f"), None if total is None else format(total, "f")
    except (DecimalException, ValidationError, ValueError):
        raise ValidationFailed(
            "Preparation result exceeds positive exact quantity bounds."
        ) from None


def compute(user, request):
    user = current_actor(user)
    # Authorize every supplied revision and source closure before selection diagnostics.
    subject = get_revision(user, request.revision_id)
    # Applied profiles stay in the subject's workspace (NotFound before diagnostics).
    with pin_workspace(subject.definition.workspace_id):
        revisions = {
            a.profile_revision_id: get_revision(user, a.profile_revision_id)
            for a in request.applications
        }
        profiles = {rid: profile_revision(user, rid) for rid in revisions}
    pieces = {}
    if subject.definition.kind == "cable" and not is_section_revision(subject):
        inspected = inspect_cable(user, subject.id)
        values = {row["target"]: row for row in inspected["lengths"]["rows"]}
        pieces[None] = {
            "stock_revision_id": inspected["cable"]["stock_revision_id"],
            "segment_ids": [],
            "inputs": values,
        }
    elif is_section_revision(subject):
        _, harness = read_harness(user, subject.id)
        for section in harness.harness.sections:
            pieces[section.local_id] = {
                "stock_revision_id": str(section.stock_revision_id),
                "segment_ids": [
                    s.local_id for s in harness.harness.segments if s.section_id == section.local_id
                ],
                "inputs": {
                    "stock_cut": {
                        "declaration": {
                            "amount_mm": str(section.planned_cut_length_mm)
                            if section.planned_cut_length_mm is not None
                            else None,
                            "basis": "human_declaration",
                            "explanation": section.cut_basis,
                        },
                        "suggested_mm": None,
                    }
                },
            }
    else:
        raise ValidationFailed("Preparation requires an exact cable or harness revision.")
    if sum(len(profiles[a.profile_revision_id][1].formulas) for a in request.applications) > 4096:
        raise ValidationFailed("Preparation projection exceeds the 4096 formula-row limit.")
    rows = []
    for application in request.applications:
        piece = pieces.get(application.section_id)
        revision, profile, stock, elements = profiles[application.profile_revision_id]
        if piece is None:
            raise ValidationFailed(
                "Application must identify an exact physical section (null for cable)."
            )
        if str(profile.stock_revision_id) != piece["stock_revision_id"]:
            raise ValidationFailed(
                "Preparation profile must pin the physical section's exact stock revision."
            )
        for formula in profile.formulas:
            key = (
                f"conductor:{formula.element_path}"
                if formula.input_length == "conductor_cut"
                else formula.input_length
            )
            source = piece["inputs"].get(key)
            base = (
                None
                if source is None
                else source["declaration"]["amount_mm"]
                if formula.input_basis == "declaration"
                else source["suggested_mm"]
            )
            cut, total = (
                (None, None)
                if formula.review != "reviewed"
                else exact_result(base, formula.allowances, request.quantity)
            )
            declared_key = (
                "stock_cut"
                if formula.target == "stock_piece"
                else f"conductor:{formula.element_path}"
            )
            declared = piece["inputs"].get(declared_key, {}).get("declaration", {}).get("amount_mm")
            rows.append(
                {
                    "section_id": application.section_id,
                    "segment_ids": piece["segment_ids"],
                    "target": formula.target,
                    "element_path": formula.element_path,
                    "element_kind": elements[formula.element_path].kind
                    if formula.element_path
                    else None,
                    "profile_revision_id": str(revision.id),
                    "profile_sha256": revision.snapshot.sha256,
                    "stock_revision_id": str(stock.id),
                    "stock_sha256": stock.snapshot.sha256,
                    "formula": formula.model_dump(mode="json"),
                    "input_mm": base,
                    "input_provenance": source,
                    "cut_mm": cut,
                    "total_mm": total,
                    "declared_cut_mm": declared,
                    "declaration_matches_result": Decimal(declared) == Decimal(cut)
                    if declared is not None and cut is not None
                    else None,
                    "status": "unreviewed_formula"
                    if formula.review != "reviewed"
                    else "unknown_inputs"
                    if cut is None
                    else "calculated_suggestion",
                }
            )
    selected = {a.section_id for a in request.applications}
    return {
        "revision_id": str(subject.id),
        "sha256": subject.snapshot.sha256,
        "definition_id": str(subject.definition_id),
        "kind": subject.definition.kind,
        "quantity": request.quantity,
        "rows": rows,
        "unprofiled_sections": [section for section in pieces if section not in selected],
        "physical_piece_count": None
        if request.quantity is None
        else len(selected) * request.quantity,
        "application": "read_only_suggestion",
        "stock_facts_written": False,
        "prepend": "unsupported",
        "clearance": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }
