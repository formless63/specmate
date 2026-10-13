"""Shared exact build-sheet quantities; allowance detail is never added twice."""

from decimal import Decimal, DecimalException, Inexact, Rounded, localcontext

from pydantic import ValidationError

from specmate.cables.queries import inspect_revision as inspect_cable
from specmate.end_preparation.application import apply_profile
from specmate.harnesses.queries import read_revision as read_harness
from specmate.inventory.contracts import QUANTITY_CONTEXT, UNITS, Quantity
from specmate.inventory.queries import get_consumption, returnable_quantity
from specmate.operations import ValidationFailed
from specmate.preparation.calculation import compute
from specmate.preparation.contracts import ComputeCuts
from specmate.queries import get_revision


def arithmetic(values, unit, quantity=1, *, subtract=False):
    if quantity is None or any(v is None for v in values):
        return None
    try:
        with localcontext(QUANTITY_CONTEXT) as context:
            context.traps[Inexact] = True
            context.traps[Rounded] = True
            numbers = [Decimal(str(v)) for v in values]
            result = (numbers[0] - sum(numbers[1:]) if subtract else sum(numbers)) * quantity
            Quantity(amount=result, unit=unit)
            return format(result, "f")
    except (DecimalException, ValueError, ValidationError):
        raise ValidationFailed("Material accounting exceeds exact quantity bounds.") from None


def nonnegative(quantity):
    if quantity.amount is not None:
        Quantity(amount=quantity.amount, unit=quantity.unit)
        if quantity.amount < 0:
            raise ValidationFailed("Material demand cannot be negative.")
    return quantity.amount


def reconcile(user, record, item_revision_id, subject_revision_id, dimension):
    if record is None:
        return None
    if UNITS[record.retained.unit][0] != dimension:
        raise ValidationFailed("Reconciliation must match the material dimension.")
    retained, waste = nonnegative(record.retained), nonnegative(record.waste)
    entries = [get_consumption(user, cid) for cid in record.consumption_ids]
    for entry in entries:
        if entry.account.lot.revision_id != item_revision_id:
            raise ValidationFailed("Inventory evidence must pin this exact material revision.")
        if entry.work_batch.revision_id != subject_revision_id:
            raise ValidationFailed("Inventory evidence must belong to this exact subject revision.")
        if entry.account.dimension != dimension:
            raise ValidationFailed("Inventory evidence must match the material dimension.")
    # No selected entries means issue is unknown, not an inferred zero.
    scale = UNITS[record.retained.unit][1]
    issued = (
        arithmetic(
            [entry.before - entry.after for entry in entries],
            {"count": "ea", "length": "m", "mass": "kg"}[dimension],
        )
        if entries
        else None
    )
    returned = (
        arithmetic(
            [entry.before - entry.after - returnable_quantity(entry) for entry in entries],
            {"count": "ea", "length": "m", "mass": "kg"}[dimension],
        )
        if entries
        else None
    )
    with localcontext(QUANTITY_CONTEXT):
        issued = None if issued is None else format(Decimal(issued) / scale, "f")
        returned = None if returned is None else format(Decimal(returned) / scale, "f")
    net = arithmetic([issued, returned], record.retained.unit, subtract=True)
    residual = arithmetic([net, retained, waste], record.retained.unit, subtract=True)
    return {
        "record": record.model_dump(mode="json"),
        "unit": record.retained.unit,
        "issued": issued,
        "returned": returned,
        "net_issued": net,
        "unallocated": residual,
        "status": "unknown"
        if residual is None
        else "balanced"
        if Decimal(residual) == 0
        else "overallocated"
        if Decimal(residual) < 0
        else "unallocated_material",
        "basis": "entire_batch_observations_not_scaled_by_planned_quantity",
        "inventory_entries": [
            {
                "consumption_id": str(e.id),
                "account_id": str(e.account_id),
                "work_batch_id": str(e.work_batch_id),
                "physical_unit_id": str(e.physical_unit_id) if e.physical_unit_id else None,
                "assertion_source": e.assertion_source,
                "assertion_status": e.assertion_status,
            }
            for e in entries
        ],
    }


def project(user, plan):
    subject = get_revision(user, plan.subject_revision_id)
    if subject.definition.kind == "cable":
        cable = inspect_cable(user, subject.id)
        declaration = next(r for r in cable["lengths"]["rows"] if r["target"] == "stock_cut")
        physical = {
            None: {
                "stock_revision_id": cable["cable"]["stock_revision_id"],
                "declared_cut_mm": declaration["declaration"]["amount_mm"],
                "cut_provenance": declaration,
                "segment_ids": [],
            }
        }
    elif subject.definition.kind == "harness":
        _, inspected = read_harness(user, subject.id)
        harness = inspected.harness
        physical = {
            s.local_id: {
                "stock_revision_id": str(s.stock_revision_id),
                "declared_cut_mm": None
                if s.planned_cut_length_mm is None
                else str(s.planned_cut_length_mm),
                "cut_provenance": {"basis": s.cut_basis},
                "segment_ids": [g.local_id for g in harness.segments if g.section_id == s.local_id],
            }
            for s in harness.sections
        }
    else:
        raise ValidationFailed("Material plans require an exact cable or harness revision.")
    applications = [
        {"section_id": p.section_id, "profile_revision_id": p.profile_revision_id}
        for p in plan.pieces
        if p.profile_revision_id
    ]
    cuts = (
        compute(
            user,
            ComputeCuts(revision_id=subject.id, applications=applications, quantity=plan.quantity),
        )
        if applications
        else None
    )
    rows = []
    for piece in plan.pieces:
        if piece.section_id not in physical:
            raise ValidationFailed("Select an exact physical section (null for cable).")
        info = physical[piece.section_id]
        stock = get_revision(user, info["stock_revision_id"])
        suggestion = next(
            (
                r
                for r in (cuts["rows"] if cuts else [])
                if r["section_id"] == piece.section_id and r["target"] == "stock_piece"
            ),
            None,
        )
        if piece.cut_basis == "preparation_suggestion" and suggestion is None:
            raise ValidationFailed("Selected preparation must contain a whole-stock-piece formula.")
        cut = (
            suggestion["cut_mm"]
            if piece.cut_basis == "preparation_suggestion"
            else info["declared_cut_mm"]
        )
        procurement = arithmetic([cut, piece.extra_waste.amount_mm], "mm", plan.quantity)
        rows.append(
            {
                "section_id": piece.section_id,
                **info,
                "stock_sha256": stock.snapshot.sha256,
                "installed_mm": None
                if piece.installed.amount_mm is None
                else str(piece.installed.amount_mm),
                "installed_total_mm": arithmetic([piece.installed.amount_mm], "mm", plan.quantity),
                "installed_provenance": piece.installed.model_dump(mode="json"),
                "cut_basis": piece.cut_basis,
                "cut_mm": cut,
                "cut_total_mm": arithmetic([cut], "mm", plan.quantity),
                "preparation": suggestion,
                "extra_waste_mm": None
                if piece.extra_waste.amount_mm is None
                else str(piece.extra_waste.amount_mm),
                "extra_waste_total_mm": arithmetic(
                    [piece.extra_waste.amount_mm], "mm", plan.quantity
                ),
                "waste_provenance": piece.extra_waste.model_dump(mode="json"),
                "cut_minus_installed_mm": arithmetic(
                    [cut, piece.installed.amount_mm], "mm", subtract=True
                ),
                "procurement_mm": procurement if plan.decision == "make" else None,
                "procurement_status": "included"
                if plan.decision == "make"
                else "bought_boundary"
                if plan.decision == "buy"
                else "unresolved_decision",
                "reconciliation": reconcile(
                    user, piece.reconciliation, stock.id, subject.id, "length"
                ),
            }
        )
    consumables = []
    for need in plan.consumables:
        if str(need.revision_id) in {p["stock_revision_id"] for p in physical.values()}:
            raise ValidationFailed("Retained physical stock cannot be duplicated as a consumable.")
        net = nonnegative(need.quantity)
        waste = None if need.waste is None else nonnegative(need.waste.quantity)
        unit = need.quantity.unit
        if need.waste and need.waste.quantity.unit != unit:
            raise ValidationFailed("Consumable demand and additive waste must use the same unit.")
        item = get_revision(user, need.revision_id)
        consumables.append(
            {
                "local_id": need.local_id,
                "revision_id": str(item.id),
                "sha256": item.snapshot.sha256,
                "declaration": need.model_dump(mode="json"),
                "unit": unit,
                "net_quantity": arithmetic([net], unit, plan.quantity),
                "waste_quantity": arithmetic([waste], unit, plan.quantity),
                "procurement_quantity": arithmetic([net, waste], unit, plan.quantity)
                if plan.decision == "make"
                else None,
                "procurement_status": "included"
                if plan.decision == "make"
                else "bought_boundary"
                if plan.decision == "buy"
                else "unresolved_decision",
                "reconciliation": reconcile(
                    user, need.reconciliation, item.id, subject.id, UNITS[unit][0]
                ),
            }
        )
    ends = None
    if plan.end_preparation:
        if plan.end_preparation.cable_revision_id != subject.id:
            raise ValidationFailed(
                "End instructions must select the plan's exact subject revision."
            )
        ends = apply_profile(user, plan.end_preparation)
    return {
        "subject_revision_id": str(subject.id),
        "subject_sha256": subject.snapshot.sha256,
        "quantity": plan.quantity,
        "decision": plan.decision,
        "pieces": rows,
        "unplanned_sections": [s for s in physical if s not in {p.section_id for p in plan.pieces}],
        "consumables": consumables,
        "end_preparation": ends,
        "purchased_subject_quantity": plan.quantity if plan.decision == "buy" else None,
        "ledger_written": False,
        "physical_qualification": "not_evaluated",
        "limitations": [
            "Installed length is independent; finished or route length is not substituted.",
            "Cut contains slack/preparation/trim; add only separately declared extra waste.",
            "Cut minus installed is unclassified surplus, not evidence of discarded material.",
            "Conductor cuts and layer strips are inspection detail, not extra stock demand.",
            "This exact subject projection must not be appended to overlapping BOM rows.",
            "Reconciliation uses current authorized returns; ledger events remain independent.",
        ],
    }
