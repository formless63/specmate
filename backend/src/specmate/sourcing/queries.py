"""Combine a frozen need with live stock and dated, reviewed offers.

Everything here is read-only. Absent prices, currencies, freshness or stock stay unknown
and never block the underlying build sheet; nothing is fetched from outside the workspace.
"""

from collections import defaultdict
from decimal import Decimal

from django.utils import timezone

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.inventory.contracts import CANONICAL_UNITS, UNITS, quantity_subtract
from specmate.inventory.models import StockAccount
from specmate.inventory.queries import decimal_text, get_account, latest_entry, reserved_quantity
from specmate.operations import ValidationFailed
from specmate.queries import get_revision
from specmate.sourcing.models import SupplierOffer


def offer_result(offer):
    return {
        "offer_id": str(offer.id),
        "workspace_id": str(offer.workspace_id),
        "revision_id": str(offer.revision_id),
        "supplier": offer.supplier,
        "supplier_ref": offer.supplier_ref,
        "source": offer.source,
        "review_basis": offer.review_basis,
        "reviewed_by": {"id": offer.reviewed_by_id, "username": offer.reviewed_by.get_username()},
        "offered_on": offer.offered_on.isoformat(),
        "valid_until": offer.valid_until.isoformat() if offer.valid_until else None,
        "price": {
            "amount": decimal_text(offer.price_amount) if offer.price_amount is not None else None,
            "currency": offer.price_currency,
            "per_unit": offer.price_unit,
        }
        if offer.price_amount is not None or offer.price_currency is not None
        else None,
        "availability": offer.availability,
        "lead_time_days": offer.lead_time_days,
        "substitution": {
            "replaces_revision_id": str(offer.substitute_for_id),
            "basis": offer.substitution_basis,
        }
        if offer.substitute_for_id
        else None,
        "supersedes_offer_id": str(offer.supersedes_id) if offer.supersedes_id else None,
        "superseded_by_offer_id": str(offer.superseded_by.id)
        if hasattr(offer, "superseded_by")
        else None,
        "created_at": offer.created_at.isoformat(),
    }


def list_offers(user, workspace_id, *, revision_id=None, offset=0, limit=50):
    user = current_actor(user)
    authorize(user, workspace_id, Perm.WORKSPACE_READ)
    query = SupplierOffer.objects.select_related("reviewed_by", "superseded_by").filter(
        workspace_id=workspace_id
    )
    if revision_id:
        query = query.filter(revision_id=revision_id)
    offers = []
    for offer in query.order_by("-offered_on", "-created_at")[offset : offset + limit]:
        get_revision(user, offer.revision_id)
        offers.append(offer_result(offer))
    return {"workspace_id": str(workspace_id), "offers": offers, "offset": offset, "limit": limit}


def freshness(offer, as_of, max_age_days):
    age = (as_of - offer.offered_on).days
    if offer.valid_until is not None and as_of > offer.valid_until:
        status = "expired"
    elif max_age_days is not None and age > max_age_days:
        status = "stale"
    elif offer.valid_until is not None or max_age_days is not None:
        status = "current"
    else:
        status = "unknown"
    return status, age


def _quantity(amount, unit):
    return {
        "status": "known" if amount is not None else "unknown",
        "amount": None if amount is None else decimal_text(amount),
        "unit": unit,
    }


def _canonical(unit_from, amount):
    dimension, factor = UNITS[unit_from]
    return CANONICAL_UNITS[dimension], amount * factor


def extract_needs(user, revision, purpose):
    """Normalize a frozen BOM or material plan into per-revision demand rows (canonical units)."""
    kind = revision.definition.kind
    needs, unresolved = [], []
    if kind == "bom_plan":
        from specmate.bom.queries import inspect_revision

        data = inspect_revision(user, revision.id, purpose)
        for row in data["rows"]:
            required = row["required_quantity"]
            net = row["net_quantity"]
            needs.append(
                {
                    "revision_id": row["revision_id"],
                    "unit": required["unit"],
                    "amount": Decimal(required["amount"])
                    if required["amount"] is not None
                    else None,
                    "net": Decimal(net["amount"]) if net["amount"] is not None else None,
                    "waste_status": row["waste_status"],
                    "origin": {"kind": "bom", "address": row["address"], "reason": row["reason"]},
                }
            )
        unresolved = data["unresolved"]
    elif kind == "material_plan":
        from specmate.material_accounting.queries import inspect_revision

        data = inspect_revision(user, revision.id)
        subject = data["subject_revision_id"]
        if data["decision"] == "buy":
            needs.append(
                {
                    "revision_id": subject,
                    "unit": "ea",
                    "amount": Decimal(data["purchased_subject_quantity"])
                    if data["purchased_subject_quantity"] is not None
                    else None,
                    "origin": {"kind": "material_plan", "reason": "bought_subject"},
                }
            )
        elif data["decision"] == "unknown":
            unresolved.append({"reason": "make_buy_unknown", "subject_revision_id": subject})
        for piece in data["pieces"]:
            if piece["procurement_status"] != "included":
                continue
            raw = piece["procurement_mm"]
            needs.append(
                {
                    "revision_id": piece["stock_revision_id"],
                    "unit": "mm",
                    "amount": Decimal(raw) if raw is not None else None,
                    "origin": {"kind": "material_plan", "section_id": piece["section_id"]},
                }
            )
        for item in data["consumables"]:
            if item["procurement_status"] != "included":
                continue
            raw = item["procurement_quantity"]
            needs.append(
                {
                    "revision_id": item["revision_id"],
                    "unit": item["unit"],
                    "amount": Decimal(raw) if raw is not None else None,
                    "origin": {"kind": "material_plan", "local_id": item["local_id"]},
                }
            )
    else:
        raise ValidationFailed("Sourcing reads an exact frozen BOM plan or material plan revision.")
    for need in needs:
        need["unit"], amount = _canonical(
            need["unit"], need["amount"] if need["amount"] is not None else Decimal(0)
        )
        need["amount"] = None if need["amount"] is None else amount
        # BOM net quantities are already canonical; other needs have no separate allowance.
        need.setdefault("net", need["amount"])
    return needs, unresolved


def stock_for(user, workspace_id, revision_id, dimension):
    accounts = (
        StockAccount.objects.select_related("lot", "location")
        .filter(lot__revision_id=revision_id, location__workspace_id=workspace_id)
        .order_by("location__name", "lot__label")
    )
    rows, available, issues = [], Decimal(0), set()
    observed = None
    unknown = 0
    for account in accounts:
        get_account(user, account.id)  # current account, work-batch and revision authority
        entry = latest_entry(account)
        quantity = entry.after if entry else None
        reserved = reserved_quantity(account)
        if account.dimension != dimension:
            issues.add("dimension_mismatch")
            usable = None
        elif quantity is None:
            unknown += 1
            usable = None
        else:
            usable = quantity_subtract(quantity, reserved)
            available += usable
        if entry and (observed is None or entry.created_at > observed):
            observed = entry.created_at
        rows.append(
            {
                "account_id": str(account.id),
                "lot_label": account.lot.label,
                "location_name": account.location.name,
                "dimension": account.dimension,
                "physical_quantity": None if quantity is None else decimal_text(quantity),
                "reserved_quantity": decimal_text(reserved),
                "available_quantity": None if usable is None else decimal_text(usable),
                "observed_at": entry.created_at.isoformat() if entry else None,
                "assertion_status": entry.assertion_status if entry else None,
                "assertion_source": entry.assertion_source if entry else None,
            }
        )
    if unknown:
        issues.add("unknown_balance")
    if not rows:
        status = "none_recorded"
    elif issues:
        status = "unknown" if all(r["available_quantity"] is None for r in rows) else "partial"
    else:
        status = "known"
    return {
        "status": status,
        "available": _quantity(
            available if status in {"known", "partial"} else None, CANONICAL_UNITS[dimension]
        ),
        "available_is_lower_bound": status == "partial",
        "observed_at": observed.isoformat() if observed else None,
        "issues": sorted(issues),
        "accounts": rows,
    }


def offer_cost(offer, shortfall, dimension, unit):
    """Estimated cost of buying ``shortfall`` at this offer, or an explained unknown."""
    if offer.price_amount is None:
        return {"status": "unknown", "reason": "price_unknown"}
    if offer.price_currency is None:
        return {"status": "unknown", "reason": "currency_unknown"}
    if UNITS[offer.price_unit][0] != dimension:
        return {"status": "unknown", "reason": "unit_mismatch"}
    if shortfall is None:
        return {"status": "unknown", "reason": "shortfall_unknown"}
    if shortfall == 0:
        return {"status": "not_needed", "reason": "no_shortfall"}
    quantity = shortfall / UNITS[offer.price_unit][1]
    return {
        "status": "known",
        "amount": decimal_text(offer.price_amount * quantity),
        "currency": offer.price_currency,
        "reason": None,
    }


def report(user, revision_id, *, purpose="procurement", as_of=None, max_age_days=None):
    user = current_actor(user)
    revision = get_revision(user, revision_id)
    workspace_id = revision.definition.workspace_id
    authorize(user, workspace_id, Perm.WORKSPACE_READ)
    as_of = as_of or timezone.localdate()
    needs, unresolved = extract_needs(user, revision, purpose)

    groups = defaultdict(list)
    for need in needs:
        groups[need["revision_id"]].append(need)
    ids = list(groups)
    candidates = list(
        SupplierOffer.objects.select_related("reviewed_by", "superseded_by", "revision__definition")
        .filter(workspace_id=workspace_id)
        .filter(models_q(ids))
        .order_by("offered_on", "created_at")
    )
    cache = {}

    def authorized(rid):
        if rid not in cache:
            cache[rid] = get_revision(user, rid)
        return cache[rid]

    rows, totals = [], defaultdict(lambda: {"amount": Decimal(0), "rows_priced": 0})
    purchase_rows = priced_rows = 0
    hidden_future = superseded_count = 0
    for rid, items in groups.items():
        item = authorized(rid)
        unit = items[0]["unit"]
        dimension = next(d for d, c in CANONICAL_UNITS.items() if c == unit)
        amounts = [i["amount"] for i in items]
        required = None if any(a is None for a in amounts) else sum(amounts, Decimal(0))
        nets = [i["net"] for i in items]
        net_required = None if any(a is None for a in nets) else sum(nets, Decimal(0))
        stock = stock_for(user, workspace_id, rid, dimension)
        available = (
            Decimal(stock["available"]["amount"])
            if stock["available"]["status"] == "known"
            else None
        )
        if required is not None and stock["status"] == "known":
            shortfall = max(required - available, Decimal(0))
            shortfall_reason = None
        else:
            shortfall = None
            if required is None:
                waste_open = any(i.get("waste_status") == "not_evaluated" for i in items)
                shortfall_reason = (
                    "waste_allowance_not_declared" if waste_open else "required_quantity_unknown"
                )
            else:
                shortfall_reason = f"stock_{stock['status']}"
        at_most = at_least = None
        if shortfall is None and required is not None:
            at_most = max(required - (available or Decimal(0)), Decimal(0))
        elif shortfall is None and net_required is not None and stock["status"] == "known":
            # Gross demand is unknown, so the net shortfall is only a lower bound.
            at_least = max(net_required - available, Decimal(0))

        offers, substitutes, best = [], [], {}
        for offer in candidates:
            exact = offer.substitute_for_id is None and str(offer.revision_id) == rid
            replaces = offer.substitute_for_id is not None and str(offer.substitute_for_id) == rid
            if not (exact or replaces):
                continue
            if offer.offered_on > as_of:
                hidden_future += 1
                continue
            if hasattr(offer, "superseded_by") and offer.superseded_by.offered_on <= as_of:
                superseded_count += 1
                continue
            state, age = freshness(offer, as_of, max_age_days)
            cost = offer_cost(offer, shortfall, dimension, unit)
            if replaces:
                authorized(str(offer.revision_id))
            entry = {
                **offer_result(offer),
                "freshness": state,
                "age_days": age,
                "estimated_cost": cost,
                # A substitute is shown for review; it never satisfies the need or enters totals.
                "counts_toward_need": exact,
            }
            if replaces:
                entry["revision_name"] = offer.revision.definition.name
                substitutes.append(entry)
                continue
            offers.append(entry)
            eligible = (
                cost["status"] == "known"
                and state in {"current", "unknown"}
                and offer.availability != "unavailable"
            )
            if eligible:
                key = cost["currency"]
                if key not in best or Decimal(cost["amount"]) < Decimal(
                    best[key]["estimated_cost"]["amount"]
                ):
                    best[key] = entry
        needs_purchase = shortfall is not None and shortfall > 0
        if needs_purchase:
            purchase_rows += 1
            if best:
                priced_rows += 1
            for currency, entry in best.items():
                totals[currency]["amount"] += Decimal(entry["estimated_cost"]["amount"])
                totals[currency]["rows_priced"] += 1
        rows.append(
            {
                "revision_id": rid,
                "name": item.definition.name,
                "required": _quantity(required, unit),
                "net_required": _quantity(net_required, unit),
                "demand": [i["origin"] for i in items],
                "stock": stock,
                "shortfall": {
                    **_quantity(shortfall, unit),
                    "reason": shortfall_reason,
                    "at_most": None if at_most is None else decimal_text(at_most),
                    "at_least": None if at_least is None else decimal_text(at_least),
                },
                "offers": offers,
                "substitutes": substitutes,
                "best_by_currency": {
                    c: {"offer_id": e["offer_id"], "estimated_cost": e["estimated_cost"]}
                    for c, e in best.items()
                },
                "offer_status": "none_on_record"
                if not offers
                else "priced"
                if best
                else "no_usable_price",
            }
        )
    unknown_rows = sum(1 for r in rows if r["shortfall"]["status"] == "unknown")
    if not rows:
        cost_status = "not_evaluated"
    elif not purchase_rows and not unknown_rows and not unresolved:
        cost_status = "not_needed"
    elif (
        purchase_rows
        and priced_rows == purchase_rows
        and len(totals) == 1
        and not unknown_rows
        and not unresolved
    ):
        cost_status = "complete"
    elif priced_rows:
        cost_status = "partial"
    else:
        cost_status = "unknown"
    return {
        "revision_id": str(revision.id),
        "kind": revision.definition.kind,
        "purpose": purpose,
        "as_of": as_of.isoformat(),
        "max_age_days": max_age_days,
        "rows": rows,
        "unresolved": unresolved,
        "cost": {
            "status": cost_status,
            "rows_shortfall_unknown": unknown_rows,
            "rows_needing_purchase": purchase_rows,
            "rows_priced": priced_rows,
            "rows_without_price": purchase_rows - priced_rows,
            "totals": [
                {
                    "currency": c,
                    "amount": decimal_text(v["amount"]),
                    "rows_priced": v["rows_priced"],
                }
                for c, v in sorted(totals.items())
            ],
        },
        "offers_after_as_of": hidden_future,
        "superseded_offers_hidden": superseded_count,
        "ledger_written": False,
        "physical_qualification": "not_evaluated",
        "limitations": [
            "Offers are dated, reviewed workspace records; no live price or stock is fetched.",
            "Stock counts only lots pinned to the exact needed revision. Substitutes never satisfy "
            "a need or enter totals until an explicit design change selects them.",
            "An unknown price, currency, balance or freshness stays unknown and is never zero.",
            "Costs are estimates for the current shortfall, not an order, quote or budget.",
        ],
    }


def models_q(ids):
    from django.db.models import Q

    return Q(revision_id__in=ids, substitute_for__isnull=True) | Q(substitute_for_id__in=ids)
